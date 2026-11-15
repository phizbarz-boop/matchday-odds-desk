'use strict';
const {randomUUID}=require('node:crypto');
const sporty=require('./sportybet');
const {modelFromStats}=require('./sportyFootballModel');
const {liveState,ongoing}=require('./liveModel');
const SPORT='sr:sport:202120001', KEY='virtual-rollover:v1', START=250000, LIMIT=30;
const TIMES=Array.from({length:48},(_,i)=>String(i>>1).padStart(2,'0')+':'+(i%2?'30':'00'));
const MARKETS={'4.5:13':['Under 4.5 Goals','u45'],'0.5:12':['Over 0.5 Goals','o05'],'1.5:12':['Over 1.5 Goals','o15']};
const money=c=>'₦'+(c/100).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2});
const idOf=x=>String(x?.eventId??x?.event_id??'');
const label=x=>typeof x==='string'?x:String(x?.name??'');
const freshState=()=>({balance:START,step:0,count:0,day:null,pending:null,last:null,watch:[],history:[],lastSlot:null});
async function stateOf(redis){const raw=await redis.get(KEY);return raw?JSON.parse(raw):freshState();}
function totals(e,fixture){
 return sporty.flattenDetailedMarkets(e,{...fixture,sport:'Virtual Football'}).flatMap(r=>{
  const line=String(r.specifier??'').match(/^total=(0\.5|1\.5|4\.5)$/)?.[1];
  const key=line+':'+r.outcomeId;
  return r.eventId===fixture.eventId&&r.marketId==='18'&&r.odds>1&&r.odds<=1.30&&MARKETS[key]?[{...fixture,marketId:r.marketId,outcomeId:r.outcomeId,specifier:r.specifier,odds:r.odds,pick:MARKETS[key][0],field:MARKETS[key][1]}]:[];
 });
}
async function fixtures(client,now,signal){
 const payload=await client.fetchPrematchPage(SPORT,1,100,{marketIds:'18',timeoutMs:7000});
 signal?.throwIfAborted();
 const seen=new Set();
 return sporty.extractUpcomingEvents(payload).events.flatMap(e=>{
  const f=sporty.fixtureContext(e,'Virtual Football');
  const sport=String(e.sport?.id??e.sportId??'');
  const tournament=label(f.tournament);
  const league=String(e.tournamentId??e.tournament?.id??(label(f.category)&&tournament?label(f.category)+'/'+tournament:''));
  const kickoffUtc=sporty.normalizeOutcome(e).kickoffUtc;
  if(require('./isSimFixture').product(e)==='srl'||(sport&&sport!==SPORT)||!/^sr:match:\d+$/.test(f.eventId)||seen.has(f.eventId)||e.banned||ongoing(e)||!f.home||!f.away||f.home===f.away||!league||!(Date.parse(kickoffUtc)>now+20000&&Date.parse(kickoffUtc)<now+1800000))return [];
  seen.add(f.eventId);
  const fixture={eventId:f.eventId,home:f.home,away:f.away,kickoffUtc,league};
  return [{fixture,rows:totals(e,fixture)}];
 }).sort((a,b)=>Date.parse(a.fixture.kickoffUtc)-Date.parse(b.fixture.kickoffUtc));
}
async function resultFor(client,f,signal){
 signal?.throwIfAborted();
 const payload=await client.fetchEventDetail(f.eventId);
 const root=payload?.data??payload, e=root?.event??root;
 if(idOf(e)!==f.eventId)return null;
 const context=sporty.fixtureContext(e,'Virtual Football');
 if(context.home!==f.home||context.away!==f.away)return null;
 const live=liveState(e);
 if(/\b(cancelled|canceled|void|abandoned)\b/i.test(live.phase))return {void:true};
 if(!/\b(?:FT|full[- ]?time|finished|ended)\b/i.test(live.phase)||/half[- ]?time|extra time/i.test(live.phase))return null;
 // Use explicit regulation score or the full-time event score, never a price or partial score.
 const regulation=require('./liveModel').scorePair(e.fullTimeScore??e.regulationScore);
 const {homeScore:h,awayScore:a}=regulation?{homeScore:regulation.home,awayScore:regulation.away}:live;
 if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)return null;
 return {h,a};
}
function predict(f,history,now){
 const cutoff=Math.min(now,Date.parse(f.kickoffUtc));
 const past=history.filter(x=>x.league===f.league&&x.eventId!==f.eventId&&x.verifiedAt<cutoff&&x.verifiedAt>=cutoff-7*86400000);
 const form=team=>past.filter(x=>x.home===team||x.away===team).sort((a,b)=>b.verifiedAt-a.verifiedAt).slice(0,12)
  .map(x=>x.home===team?[x.h,x.a]:[x.a,x.h]);
 const h=form(f.home),a=form(f.away);
 if(h.length<5||a.length<5)return null;
 const avg=(r,i)=>r.reduce((n,x)=>n+x[i],0)/r.length;
 return modelFromStats(f,{...f,capturedAt:new Date(now).toISOString(),homeGoalsFor:avg(h,0),homeGoalsAgainst:avg(h,1),awayGoalsFor:avg(a,0),awayGoalsAgainst:avg(a,1)});
}
function select(board,history,now,used=new Set()){
 const rows=board.flatMap(({fixture,rows})=>{
  if(used.has(fixture.eventId))return [];
  const model=predict(fixture,history,now);
  return model?.goalModelAvailable?rows.map(r=>({...r,probability:model[r.field]})).filter(r=>Number.isFinite(r.probability)&&r.probability>0):[];
 });
 let best=null;
 function consider(legs){
  const odds=legs.reduce((n,r)=>n*r.odds,1);
  if(odds<1.12-1e-9||odds>1.30+1e-9)return;
  const probability=legs.reduce((n,r)=>n*r.probability/100,1);
  if(!best||probability>best.probability||(probability===best.probability&&legs.length<best.legs.length))best={legs,odds,probability};
 }
 rows.forEach((r,i)=>{
  consider([r]);
  for(let j=i+1;j<rows.length;j++)if(r.eventId!==rows[j].eventId)consider([r,rows[j]]);
 });
 return best;
}
function settle(ticket,results){
 if(results.some(x=>!x))return null;
 let factor=1,active=0;
 for(const [i,r] of results.entries()){
  if(r.void)continue;
  active++;
  const leg=ticket.legs[i],total=r.h+r.a;
  const won=leg.field==='u45'?total<4.5:leg.field==='o05'?total>0.5:total>1.5;
  if(!won)return {status:'Lost',returned:0,nextBalance:START,nextStep:0};
  factor*=leg.odds;
 }
 const returned=Math.round(ticket.stake*factor);
 return {status:active?'Won':'Void',returned,nextBalance:returned,nextStep:ticket.step+(active?1:0)};
}
function summary(s){
 const p=s.pending;
 const lines=['ROLL OVER · VIRTUAL FOOTBALL',`Tracked balance: ${money(s.balance)} · Wins in this run: ${s.step}`,`Codes today: ${s.count}/${LIMIT} (WAT)`];
 if(s.last)lines.push(`Last settled: ${s.last.status} · Returned ${money(s.last.returned)}`);
 if(p)lines.push(`Pending: ${p.code} · ${p.odds.toFixed(3)}x`,`Stake ${money(p.stake)} · Potential return ${money(Math.round(p.stake*p.odds))}`,...p.legs.map(l=>`${l.home} vs ${l.away} — ${l.pick}`));
 else if(s.lastReason==='no_qualifying_ticket')lines.push('No qualifying ticket on the latest check. The model needs verified recent results for both teams.');
 else lines.push('No ticket awaiting settlement.');
 return lines.join('\n');
}
async function run({redis,slotKey,dateKey,signal,assertLease,shouldAbort},{client=sporty.direct,book=sporty.bookBet,send,clock=Date.now}){
 if(!redis)return {retryable:true,reason:'rollover_redis_required'};
 const lock=KEY+':lock', token=randomUUID();
 if(await redis.set(lock,token,{NX:true,EX:300})!=='OK')return {retryable:true,reason:'rollover_busy'};
 try{
  const s=await stateOf(redis);
  const check=async()=>{signal?.throwIfAborted();await assertLease?.();if(shouldAbort?.()||await redis.get(lock)!==token)throw Error('Roll Over slot lease expired');};
  const save=async()=>{await check();await redis.set(KEY,JSON.stringify(s));};
  const readResult=async f=>{await check();try{return await resultFor(client,f,signal);}catch(err){signal?.throwIfAborted();return null;}};
  if(s.day!==dateKey){s.day=dateKey;s.count=0;}
  if(s.pending){
   const outcomes=[];
   for(const f of s.pending.legs)outcomes.push(await readResult(f));
   const settled=settle(s.pending,outcomes);
   if(settled){
    const code=s.pending.code;
    s.last={...settled,code};s.balance=settled.nextBalance;s.step=settled.nextStep;s.pending=null;
    await save();
    await send(`ROLL OVER · ${code} · ${settled.status.toUpperCase()}\nReturn: ${money(settled.returned)} · Next stake: ${money(s.balance)}`);
   }
  }
  const now=clock();
  s.history=s.history.filter(x=>x.verifiedAt>=now-7*86400000);
  s.watch=s.watch.filter(x=>Date.parse(x.kickoffUtc)>now-86400000);
  const due=s.watch.filter(x=>Date.parse(x.kickoffUtc)<now-300000).slice(0,12);
  for(const f of due){
   const r=await readResult(f);
   if(r){s.watch=s.watch.filter(x=>x.eventId!==f.eventId);if(!r.void)s.history.push({...f,...r,verifiedAt:clock()});}
   else {s.watch=s.watch.filter(x=>x.eventId!==f.eventId);s.watch.push(f);}
  }
  const board=await fixtures(client,clock(),signal);
  const known=new Set([...s.watch,...s.history].map(x=>x.eventId));
  for(const {fixture} of board.slice(0,12))if(!known.has(fixture.eventId))s.watch.push(fixture);
  await save();
  if(s.pending||s.count>=LIMIT||s.lastSlot===slotKey)return {reason:s.pending?'awaiting_settlement':s.count>=LIMIT?'daily_cap':'already_attempted',ticketsSent:0};
  const ticket=select(board.filter(({fixture})=>Date.parse(fixture.kickoffUtc)>clock()+20000),s.history,clock(),new Set(s.used||[]));
  if(!ticket){s.lastReason='no_qualifying_ticket';await save();return {reason:s.lastReason,ticketsSent:0};}
  // Re-read the offered market IDs and prices before creating a share code.
  const refreshed=await fixtures(client,clock(),signal);
  const legs=ticket.legs.map(l=>refreshed.find(x=>x.fixture.eventId===l.eventId)?.rows.find(r=>r.specifier===l.specifier&&r.outcomeId===l.outcomeId&&r.odds===l.odds));
  if(legs.some(x=>!x))return {reason:'prices_changed',ticketsSent:0};
  s.lastSlot=slotKey;
  s.used=[...(s.used||[]),...legs.map(l=>l.eventId)].slice(-120);
  await save();
  const booked=await book(legs);
  const code=String(booked?.shareCode??'');
  if(!/^[A-Za-z0-9]{4,32}$/.test(code)||booked.unavailableOutcomes?.length)throw Error('Roll Over share code not confirmed');
  s.pending={code,legs,odds:ticket.odds,stake:s.balance,step:s.step};
  s.count++;s.lastReason=null;
  await save();
  // Persist the code before posting so an ambiguous Telegram response cannot duplicate a pick.
  await check();
  await send(summary(s)+`\nhttps://www.sportybet.com/ng/?shareCode=${code}`);
  return {ticketsSent:1};
 }finally{
  await redis.eval('if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) end',{keys:[lock],arguments:[token]}).catch(()=>{});
 }
}
// Manual checks read the saved form but never advance the scheduled chain.
async function preview(redis,{client=sporty.direct,book=null,clock=Date.now,signal}={}){
 const state=await stateOf(redis);
 const now=clock(),board=await fixtures(client,now,signal);
 const notes={fixtures:board.length,offeredSelections:board.reduce((n,x)=>n+x.rows.length,0),
  verifiedResults:state.history.filter(x=>x.verifiedAt>=now-7*86400000).length};
 const ticket=select(board.filter(x=>Date.parse(x.fixture.kickoffUtc)>clock()+20000),state.history,clock(),new Set(state.used||[]));
 if(!ticket)return {status:'no_ticket',reason:!notes.fixtures?'No upcoming virtual fixtures returned':!notes.offeredSelections?'No supported open totals were found':!notes.verifiedResults?'No verified virtual results saved yet':'No eligible combination met the form and odds requirements',...notes};
 const result={status:'preview',odds:ticket.odds,modelProbability:ticket.probability,
  selections:ticket.legs.map(({home,away,pick,odds,kickoffUtc})=>({home,away,pick,odds,kickoffUtc})),...notes};
 if(!book)return result;
 const refresh=await fixtures(client,clock(),signal);
 const legs=ticket.legs.map(l=>refresh.find(x=>x.fixture.eventId===l.eventId)?.rows.find(r=>r.marketId===l.marketId&&r.specifier===l.specifier&&r.outcomeId===l.outcomeId&&r.odds===l.odds));
 if(legs.some(x=>!x))return {...result,status:'no_ticket',reason:'Prices or availability changed before code generation'};
 signal?.throwIfAborted();
 const booked=await book(legs),code=String(booked?.shareCode??'');
 if(!/^[A-Za-z0-9]{4,32}$/.test(code)||booked.unavailableOutcomes?.length)throw Error('Roll Over test share code not confirmed');
 return {...result,status:'booked',code,link:'https://www.sportybet.com/ng/?shareCode='+code};
}
module.exports={preview,TIMES,run,stateOf,summary,select,settle,fixtures,resultFor,freshState};
