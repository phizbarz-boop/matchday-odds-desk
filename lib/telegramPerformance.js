'use strict';
const crypto=require('node:crypto');
const {watHourKey}=require('./telegramQuickCash');
const {listTrackedSlips,updateTrackedTicket}=require('./slipTracker');
const {finalEvent,bookingLegs,matchingLeg,settleSelection,ticketSettlement}=require('./liveSettlement');
const HALF_DAY=12*3600000, WAT=3600000;
function reportWindow(now=new Date()) {
  const endMs=Math.floor((now.getTime()+WAT)/HALF_DAY)*HALF_DAY-WAT;
  const end=new Date(endMs),start=new Date(endMs-HALF_DAY);
  return {key:watHourKey(end),start:start.toISOString(),end:end.toISOString()};
}
function published(slip) {return !slip.delivery || slip.delivery==='posted';}
function needsCheck(slip) {
  return !slip.lastStatusDetail?.complete || slip.lastStatusDetail?.returnMultiplier==null;
}
async function refreshTicketResults(redis,{getBooking,getEvent,shouldAbort=()=>false,now=()=>new Date(),window,
  maxTickets=500,maxDurationMs=720000}) {
  const slips=(await listTrackedSlips(redis)).filter(published);
  if (!slips.some(needsCheck)) return {checked:0,errors:0};
  const eventReads=new Map(),bookingReads=new Map();
  const memo=(map,key,fn)=>{if(!map.has(key))map.set(key,Promise.resolve().then(fn));return map.get(key);};
  let checked=0,errors=0;const updatedTickets=[],began=Date.now();
  const inWindow=s=>window&&new Date(s.postedAt||s.createdAt)>=new Date(window.start)&&new Date(s.postedAt||s.createdAt)<new Date(window.end);
  const due=slips.filter(needsCheck).sort((a,b)=>Number(!!inWindow(b))-Number(!!inWindow(a))||
    new Date(a.lastCheckedAt||0)-new Date(b.lastCheckedAt||0));
  for (const slip of due) {
    if(checked>=maxTickets || Date.now()-began>=maxDurationMs)break;
    if(shouldAbort())throw new Error('Telegram report cancelled before posting');
    let booking=null;
    try {booking=await memo(bookingReads,slip.shareCode,()=>getBooking(slip.shareCode));} catch {errors++;}
    const official=bookingLegs(booking),previous=slip.lastStatusDetail?.legDetails||[];
    const legs=[];
    for (const [index,selection] of slip.selections.entries()) {
      if(shouldAbort())throw new Error('Telegram report cancelled before posting');
      if(Date.now()-began>=maxDurationMs) {legs.push({...selection,status:'pending',returnMultiplier:null,index:index+1});continue;}
      const old=previous[index];
      const current=matchingLeg(official,selection);
      let settled=settleSelection(selection,null,current);
      if(settled.status==='pending' && old && old.status!=='pending' && old.returnMultiplier!=null) settled=old;
      if(settled.status==='pending') {
        try {
          const payload=await memo(eventReads,selection.eventId,()=>getEvent(selection.eventId));
          settled=settleSelection(selection,finalEvent(payload,selection.eventId),current);
        } catch {errors++;}
      }
      legs.push({...selection,...settled,index:index+1});
    }
    const detail=ticketSettlement(slip,legs,booking);
    // Preserve an authoritative result when a later share lookup is unavailable.
    if(!booking && slip.status==='won' && detail.status!=='won') {detail.status='won';detail.returnMultiplier=slip.lastStatusDetail?.returnMultiplier??null;}
    if(!booking && slip.status==='lost') {detail.status='lost';detail.returnMultiplier=0;}
    await updateTrackedTicket(redis,slip.ticketId||slip.shareCode,{status:detail.status,lastStatusDetail:detail,
      lastCheckedAt:now().toISOString(),...(detail.status!=='pending'?{settledAt:slip.settledAt||now().toISOString()}:{})});
    if(detail.status!=='pending' && (slip.status==='pending' || slip.lastStatusDetail?.returnMultiplier==null && detail.returnMultiplier!=null)) updatedTickets.push(slip.ticketId||slip.shareCode);
    checked++;
  }
  return {checked,errors,remainingChecks:Math.max(0,due.length-checked),updatedTickets};
}
function totals(slips) {
  const stake=100,counts={won:0,lost:0,push:0,partial_loss:0,partial_return:0,pending:0,unpriced:0};
  let returns=0,priced=0;
  for(const slip of slips) {
    const status=slip.status||'pending';counts[status in counts?status:'pending']++;
    const value=slip.lastStatusDetail?.returnMultiplier;
    if(status!=='pending' && value!=null && Number.isFinite(value) && value>=0) {returns+=stake*value;priced++;}
    else if(status!=='pending')counts.unpriced++;
  }
  const settledStake=priced*stake,profit=returns-settledStake;
  return {tickets:slips.length,stake:slips.length*stake,settledStake,pendingStake:(slips.length-priced)*stake,
    priced,returns:Math.round(returns*100)/100,profit:Math.round(profit*100)/100,roiPct:settledStake?profit/settledStake*100:null,counts};
}
function buildPerformanceReport(slips,window,updatedTickets=[]) {
  const sent=slips.filter(published);
  const inWindow=sent.filter(s=>{const t=new Date(s.postedAt||s.createdAt).getTime();return t>=new Date(window.start).getTime()&&t<new Date(window.end).getTime();});
  const ranked=inWindow.filter(s=>['lost','partial_loss'].includes(s.status)&&s.lastStatusDetail?.complete&&s.lastStatusDetail.totalLegs>0);
  const success=s=>{const c=s.lastStatusDetail.counts;return (c.won+c.push+c.half_won)/s.lastStatusDetail.totalLegs;};
  ranked.sort((a,b)=>success(b)-success(a)||a.lastStatusDetail.counts.lost-b.lastStatusDetail.counts.lost||a.shareCode.localeCompare(b.shareCode));
  const games=new Map();
  for(const s of inWindow)for(const leg of s.lastStatusDetail?.legDetails||[])if(['won','half_won'].includes(leg.status)) {
    games.set([leg.eventId,leg.marketId,leg.outcomeId,leg.specifier||''].join('|'),leg);
  }
  return {window,stakePerTicket:100,period:totals(inWindow),cumulative:totals(sent),
    wonTickets:inWindow.filter(s=>s.status==='won'),closest:ranked[0]||null,worst:ranked.at(-1)||null,
    winningGames:[...games.values()],olderUpdates:sent.filter(s=>updatedTickets.includes(s.ticketId||s.shareCode)&&!inWindow.includes(s)),
    unknownDeliveries:slips.filter(s=>s.delivery==='unknown').length};
}
const money=n=>'₦'+Number(n).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2});
const time=iso=>new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Lagos',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso));
function performanceText(report) {
  const {period,cumulative}=report;
  const label=s=>`${s.label||s.targetOdds||'Ticket'} · ${s.shareCode}`;
  const ticket=s=>{const c=s.lastStatusDetail.counts;return `${label(s)} — ${c.won} won, ${c.lost} lost, ${c.push} void${c.half_won||c.half_lost?`, ${c.half_won} half won, ${c.half_lost} half lost`:''}`;};
  const profit=t=>`${t.profit<0?'Loss':t.profit>0?'Profit':'Break-even'}: ${money(Math.abs(t.profit))} · ROI: ${t.roiPct==null?'pending':t.roiPct.toFixed(1)+'%'}`;
  const lines=['📊 PLOT207 SPORTS • 12-HOUR RESULTS',`${time(report.window.start)} → ${time(report.window.end)} WAT`,
    'Hypothetical stake: ₦100 per sent ticket · returns before taxes/bonuses','',
    `Tickets: ${period.tickets} · ${period.counts.won} won · ${period.counts.lost} lost · ${period.counts.push} void · ${period.counts.partial_loss} partial loss${period.counts.partial_return?" · "+period.counts.partial_return+" partial return":""} · ${period.counts.pending} pending`,
    `Total staked: ${money(period.stake)} · Confirmed returns: ${money(period.returns)}`,
    profit(period),`Settled stake: ${money(period.settledStake)} · Unresolved stake: ${money(period.pendingStake)}`,'',
    '🏆 WON TICKETS'];
  if(!report.wonTickets.length)lines.push('No confirmed winning tickets in this period.');
  else for(const slip of report.wonTickets) {
    const m=slip.lastStatusDetail?.returnMultiplier;
    lines.push(`${label(slip)} — ${m==null?'return unresolved':money(100*m)+' return'}`);
  }
  lines.push('',`🎯 Closest shot: ${report.closest?ticket(report.closest):'No fully resolved losing ticket yet.'}`,
    `📉 Worst: ${report.worst?ticket(report.worst):'No fully resolved losing ticket yet.'}`,'','✅ WINNING SELECTIONS');
  if(!report.winningGames.length)lines.push('No confirmed winning selections yet.');
  else {
    for(const g of report.winningGames.slice(0,10))lines.push(`${g.home} vs ${g.away} · ${g.outcomeDesc} (${g.marketDesc})${g.status==='half_won'?' — half won':''}`);
    if(report.winningGames.length>10)lines.push(`+${report.winningGames.length-10} more winning selections.`);
  }
  lines.push('','📈 ALL TRACKED SENT TICKETS',`${cumulative.tickets} tickets · Staked: ${money(cumulative.stake)} · Confirmed returns: ${money(cumulative.returns)}`,
    profit(cumulative),`Unresolved stake: ${money(cumulative.pendingStake)}. ROI uses settled, priced tickets only.`);
  if(report.unknownDeliveries)lines.push(`${report.unknownDeliveries} ticket delivery/ies unconfirmed; excluded from stake totals.`);
  if(report.olderUpdates?.length) {
    lines.push('','🕒 EARLIER TICKETS NOW UPDATED');
    for(const s of report.olderUpdates)lines.push(`${label(s)} — ${s.status.toUpperCase().replace(/_/g,' ')}${s.lastStatusDetail?.returnMultiplier!=null?' · '+money(100*s.lastStatusDetail.returnMultiplier)+' return':''}`);
  }
  return lines.join('\n');
}

function registerTelegramPerformanceRoute(app,{express,authorize,getRedis,runReport,now=()=>new Date(),logger=console}) {
  app.post('/api/telegram/performance-report',express.json(),async(req,res)=>{
    if(!authorize(req))return res.status(401).json({error:'unauthorized'});
    const window=reportWindow(now()),lockKey=`telegram:performance:once:${window.key}`;
    let redis,token,acquired=false,posting=false,cancelled=false;
    res.once('close',()=>{if(!res.writableEnded&&!posting)cancelled=true;});
    const unlock=()=>redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',{keys:[lockKey],arguments:[token]});
    try {
      redis=await getRedis();
      if(!redis)return res.status(503).json({error:'REDIS_URL required for performance reporting'});
      token=crypto.randomUUID();acquired=await redis.set(lockKey,token,{NX:true,EX:172800})==='OK';
      if(!acquired)return res.json({ok:true,sent:false,skipped:true,reason:'already_reported_this_period',window});
      const result=await runReport({redis,window,shouldAbort:()=>cancelled,onPostingStart:async()=>{
        if(cancelled)throw new Error('Telegram report cancelled before posting');posting=true;
      }});
      if(!res.destroyed)return res.json({ok:true,...result,window});
    }catch(err){
      if(acquired&&!posting)await unlock().catch(()=>{});
      logger.error('Telegram performance report failed:',err.message);
      if(!res.destroyed)return res.status(502).json({error:'Telegram performance report failed',detail:String(err.message).slice(0,250)});
    }
  });
}
module.exports={reportWindow,refreshTicketResults,totals,buildPerformanceReport,performanceText,registerTelegramPerformanceRoute};
