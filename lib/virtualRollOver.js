'use strict';
const {randomUUID}=require('node:crypto');
const sporty=require('./sportybet');
const {RULES:RDP_RULES}=require('../jobs/rollover-run-state.cjs');
const {modelFromStats}=require('./sportyFootballModel');
const {liveState,ongoing}=require('./liveModel');
const learning=require('./strategyLearning');
const SPORT='sr:sport:202120001', KEY='virtual-rollover:v1', START=250000;
const STANDARD=Object.freeze({key:KEY,minOdds:1.12,maxOdds:1.30,maxLegs:2,opening:START,marketFields:Object.freeze(['o05','o15','u45']),title:'ROLL OVER · VIRTUAL FOOTBALL'});
const RDP=Object.freeze({key:'virtual-rollover:rdp:v1',minOdds:1.15,maxOdds:1.55,maxLegs:RDP_RULES.maxLegs,opening:200000,marketFields:Object.freeze(['o05','u45','u55','h35']),title:'RDP ROLL OVER · VIRTUAL FOOTBALL'});
const TIMES=Array.from({length:48},(_,i)=>String(i>>1).padStart(2,'0')+':'+(i%2?'30':'00'));
const MARKETS={'4.5:13':['Under 4.5 Goals','u45'],'0.5:12':['Over 0.5 Goals','o05'],'1.5:12':['Over 1.5 Goals','o15'],'5.5:13':['Under 5.5 Goals','u55']};
const money=c=>'₦'+(c/100).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2});
const idOf=x=>String(x?.eventId??x?.event_id??'');
const label=x=>typeof x==='string'?x:String(x?.name??'');
const freshState=(lane=STANDARD)=>({balance:lane.opening??START,step:0,count:0,day:null,pending:null,last:null,watch:[],history:[],lastSlot:null});
async function stateOf(redis,lane=STANDARD){const raw=await redis.get(lane.key);if(!raw)return freshState(lane);const state=JSON.parse(raw);if(lane.opening&&!state.pending&&state.step===0&&state.balance===START)state.balance=lane.opening;return state;}
async function resetRdpCodeCount(redis,{orderId,dateKey}){
 const lock=RDP.key+':lock',token=randomUUID();
 if(await redis.set(lock,token,{NX:true,EX:30})!=='OK')return {status:'busy'};
 try{
  const state=await stateOf(redis,RDP);
  const applied=state.lossResetDay===dateKey?state.lossResetOrders||[]:[];
  if(applied.includes(orderId))return {status:'already_reset'};
  state.day=dateKey;
  state.count=0;
  state.lossResetDay=dateKey;
  state.lossResetOrders=[...applied,orderId];
  const saved=await redis.eval('if redis.call("GET",KEYS[1])==ARGV[1] then redis.call("SET",KEYS[2],ARGV[2]); return 1 end',
   {keys:[lock,RDP.key],arguments:[token,JSON.stringify(state)]});
  return {status:saved===1?'reset':'busy'};
 }finally{
  await redis.eval('if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) end',{keys:[lock],arguments:[token]}).catch(()=>{});
 }
}
function totals(e,fixture,lane){
 return sporty.flattenDetailedMarkets(e,{...fixture,sport:'Virtual Football'}).flatMap(r=>{
  const line=String(r.specifier??'').match(/^total=(0\.5|1\.5|3\.5|4\.5|5\.5)$/)?.[1];
  const listed=r.marketId==='18'?MARKETS[line+':'+r.outcomeId]:null;
  const marketName=String(r.marketDesc||'').toLowerCase();
  const half=line==='3.5'&&String(r.outcomeId)==='13'&&(r.marketId==='68'||/(?:1st|first)\s+half|halftime|half time|half-time/.test(marketName))?['Halftime Under 3.5','h35']:null;
  const hit=listed||half;
  return hit&&r.eventId===fixture.eventId&&r.odds>1&&r.odds<=(lane.maxLegOdds??lane.maxOdds)&&(!lane.marketFields||lane.marketFields.includes(hit[1]))?[{...fixture,marketId:r.marketId,outcomeId:r.outcomeId,specifier:r.specifier,odds:r.odds,pick:hit[0],field:hit[1]}]:[];
 });
}
function rdpVirtualCountry(...labels){
 const rules=[['spain','spain'],['spanish','spain'],['españa','spain'],['france','france'],['french','france'],['français','france'],['england','england'],['english','england']];
 const found=new Set();
 for(const value of labels){
  const name=label(value).toLowerCase();
  if(!name)continue;
  for(const [word,country] of rules)if(name===word||new RegExp('(?:^|[^a-z])'+word+'(?:[^a-z]|$)','i').test(name))found.add(country);
 }
 return found.size===1?[...found][0]:null;
}
const isRdpVirtualCountry=country=>['spain','france','england'].includes(country);
function rdpRowAllowed(row){
 const place=rdpVirtualCountry(row?.country,row?.league);
 if(row?.field==='o05')return place==='england';
 return (row?.field==='u45'||row?.field==='u55'||row?.field==='h35')&&(place==='spain'||place==='france');
}
async function fixtures(client,now,signal,lane=STANDARD){
 const payload=await client.fetchPrematchPage(SPORT,1,100,{marketIds:lane.key===RDP.key?'18,68':'18',timeoutMs:7000});
 signal?.throwIfAborted();
 const seen=new Set();
 return sporty.extractUpcomingEvents(payload).events.flatMap(e=>{
  const f=sporty.fixtureContext(e,'Virtual Football');
  const sport=String(e.sport?.id??e.sportId??'');
  const tournament=label(f.tournament);
  const league=String(e.tournamentId??e.tournament?.id??(label(f.category)&&tournament?label(f.category)+'/'+tournament:''));
  const kickoffUtc=sporty.normalizeOutcome(e).kickoffUtc;
  if(require('./isSimFixture').product(e)==='srl'||(sport&&sport!==SPORT)||!/^sr:match:\d+$/.test(f.eventId)||seen.has(f.eventId)||e.banned||ongoing(e)||!f.home||!f.away||f.home===f.away||!league||!(Date.parse(kickoffUtc)>now+20000&&Date.parse(kickoffUtc)<now+1800000))return [];
  const country=rdpVirtualCountry(f.category,f.tournament);
  seen.add(f.eventId);
  const fixture={eventId:f.eventId,home:f.home,away:f.away,kickoffUtc,league,...(country?{country}:{})};
  return [{fixture,rows:totals(e,fixture,lane)}];
 }).sort((a,b)=>Date.parse(a.fixture.kickoffUtc)-Date.parse(b.fixture.kickoffUtc));
}
async function resultFor(client,f,signal,observed=null,clock=Date.now){
 signal?.throwIfAborted();
 const payload=await client.fetchEventDetail(f.eventId);
 const root=payload?.data??payload, e=root?.event??root;
 if(idOf(e)!==f.eventId)return null;
 const context=sporty.fixtureContext(e,'Virtual Football');
 if(context.home!==f.home||context.away!==f.away)return null;
 const live=liveState(e);
 if(/\b(cancelled|canceled|void|abandoned)\b/i.test(live.phase))return {void:true};
 const virtualEnded=/^end$/i.test(String(e.matchStatus??'').trim());
 if((!virtualEnded&&!/\b(?:FT|full[- ]?time|finished|ended)\b/i.test(live.phase))||/half[- ]?time|extra time/i.test(live.phase)){
  if(observed&&ongoing(e)&&clock()>=Date.parse(f.kickoffUtc))observed.startedObservedAt??=new Date(clock()).toISOString();
  return null;
 }
 if(observed)observed.finishedObservedAt??=new Date(clock()).toISOString();
 // Use explicit regulation score or the full-time event score, never a price or partial score.
 const regulation=require('./liveModel').scorePair(e.fullTimeScore??e.regulationScore??(virtualEnded?e.setScore:null));
 const {homeScore:h,awayScore:a}=regulation?{homeScore:regulation.home,awayScore:regulation.away}:live;
 if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)return null;
 const halves=require('./liveModel').scoreSeries(e.gameScore),first=halves[0];
 const fh=first&&Number.isInteger(first.home+first.away)?first.home+first.away:null;
 return Number.isInteger(fh)?{h,a,fh}:{h,a};
}
function predict(f,history,now,formPanel){
 const cutoff=Math.min(now,Date.parse(f.kickoffUtc));
 const past=history.filter(x=>x.league===f.league&&x.eventId!==f.eventId&&x.verifiedAt<cutoff&&x.verifiedAt>=cutoff-7*86400000);
 const form=team=>past.filter(x=>x.home===team||x.away===team).sort((a,b)=>b.verifiedAt-a.verifiedAt).slice(0,12)
  .map(x=>x.home===team?[x.h,x.a]:[x.a,x.h]);
 const h=formPanel?.home??form(f.home),a=formPanel?.away??form(f.away);
 if(h.length<5||a.length<5)return null;
 const avg=(r,i)=>r.reduce((n,x)=>n+x[i],0)/r.length;
 return modelFromStats(f,{...f,capturedAt:new Date(now).toISOString(),homeGoalsFor:avg(h,0),homeGoalsAgainst:avg(h,1),awayGoalsFor:avg(a,0),awayGoalsAgainst:avg(a,1)});
}
function goalProbability(model,field){
 if(field!=='u55'&&field!=='h35')return model[field];
 const {goalLambdaHome:h,goalLambdaAway:a}=model;
 if(![h,a].every(x=>Number.isFinite(x)&&x>=0))return null;
 const lambda=field==='h35'?(h+a)/2:h+a,limit=field==='h35'?3:5;
 let term=Math.exp(-lambda),sum=term;
 for(let goals=1;goals<=limit;goals++){term*=lambda/goals;sum+=term;}
 return Math.min(100,100*sum);
}
function select(board,history,now,used=new Set(),lane=STANDARD){
 if(lane.key===RDP.key)board=(board||[]).map(item=>({...item,rows:(item.rows||[]).filter(rdpRowAllowed)})).filter(item=>item.rows.length);
 const rows=board.flatMap(({fixture,rows})=>{
  if(used.has(fixture.eventId))return [];
  const model=predict(fixture,history,now,fixture.formPanel);
  return model?.goalModelAvailable?rows.map(r=>({...r,probability:goalProbability(model,r.field)})).filter(r=>Number.isFinite(r.probability)&&r.probability>0&&r.probability<=100):[];
 });
 let best=null;
 const legs=[], events=new Set();
 function visit(start,odds,probability){
  if(odds>=lane.minOdds-1e-9&&(!best||probability>best.probability||(probability===best.probability&&legs.length<best.legs.length)))
   best={legs:[...legs],odds,probability};
  if(legs.length===lane.maxLegs||best&&probability<best.probability)return;
  for(let i=start;i<rows.length;i++){
   const r=rows[i], combined=odds*r.odds;
   if(r.odds>(lane.maxLegOdds??lane.maxOdds)||combined>lane.maxOdds+1e-9||events.has(r.eventId))continue;
   legs.push(r);events.add(r.eventId);
   visit(i+1,combined,probability*r.probability/100);
   events.delete(r.eventId);legs.pop();
  }
 }
 visit(0,1,1);
 return best;
}
async function addVirtualForm(board,history,now,signal,readForm){
 for(const {fixture,rows} of board.filter(x=>x.rows.length&&!predict(x.fixture,history,now)).slice(0,4)){
  if(signal?.aborted)break;
  try{const form=await readForm(fixture,{signal});if(form)fixture.formPanel=form;}
  catch(err){console.warn('[Virtual Roll Over stats]',String(err.message).slice(0,140));}
 }
}
const configuredForm=()=>process.env.VIRTUAL_ROLLOVER_STATS_ENABLED!=='false'?require('./virtualRollOverForm').collect:null;
function settle(ticket,results,opening=START){
 if(results.some(x=>!x))return null;
 let factor=1,active=0;
 for(const [i,r] of results.entries()){
  if(r.void)continue;
  active++;
  const leg=ticket.legs[i],total=r.h+r.a;
  const won=leg.field==='h35'?(Number.isInteger(r.fh)?r.fh<3.5:null):leg.field==='u55'?total<5.5:leg.field==='u45'?total<4.5:leg.field==='o05'?total>0.5:total>1.5;
  if(won==null)return null;
  if(!won)return {status:'Lost',returned:0,nextBalance:opening,nextStep:0};
  factor*=leg.odds;
 }
 const returned=Math.round(ticket.stake*factor);
 return {status:active?'Won':'Void',returned,nextBalance:returned,nextStep:ticket.step+(active?1:0)};
}
function summary(s,lane=STANDARD){
 const p=s.pending;
 const lines=[lane.title,`Tracked balance: ${money(s.balance)} · Wins in this run: ${s.step}`,`Codes today: ${s.count} (WAT)`];
 const timingLabel=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Lagos',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value))+' WAT';
 for(const row of Object.values(s.last?.timings??{})){
  const times=[row.kickoffUtc&&'Kickoff scheduled: '+timingLabel(row.kickoffUtc),row.startedObservedAt&&'Live first seen: '+timingLabel(row.startedObservedAt),row.finishedObservedAt&&'Finish confirmed: '+timingLabel(row.finishedObservedAt)].filter(Boolean);
  if(times.length)lines.push(times.join(' · '));
 }
 if(s.last)lines.push(`Last settled: ${s.last.status} · Returned ${money(s.last.returned)}`);
 if(p&&Number.isFinite(p.modelProbability))lines.push(`Model estimate: ${(p.modelProbability*100).toFixed(1)}%${p.legs.length>1?' (assuming independent legs)':''}`);
 if(p)lines.push(`Pending: ${p.code} · ${p.odds.toFixed(3)}x`,`Stake ${money(p.stake)} · Potential return ${money(Math.round(p.stake*p.odds))}`,...p.legs.map(l=>`${l.home} vs ${l.away} — ${l.pick}`));
 else if(s.lastReason==='no_qualifying_ticket')lines.push('No qualifying ticket on the latest check. The model needs verified recent results for both teams.');
 else lines.push('No ticket awaiting settlement.');
 return lines.join('\n');
}
async function run({redis,slotKey,dateKey,signal,assertLease,shouldAbort,pendingCode},{client=sporty.direct,book=sporty.bookBet,send,clock=Date.now,readForm=configuredForm(),lane=STANDARD}){
 if(!redis)return {retryable:true,reason:'rollover_redis_required'};
 const lock=lane.key+':lock', token=randomUUID();
 if(await redis.set(lock,token,{NX:true,EX:300})!=='OK')return {retryable:true,reason:'rollover_busy'};
 try{
  const s=await stateOf(redis,lane);
  if(pendingCode&&s.pending?.code!==pendingCode)return {reason:'pending_changed',ticketsSent:0};
  const check=async()=>{signal?.throwIfAborted();await assertLease?.();if(shouldAbort?.()||await redis.get(lock)!==token)throw Error('Roll Over slot lease expired');};
  const save=async()=>{await check();await redis.set(lane.key,JSON.stringify(s));};
  const readResult=async (f,observed)=>{await check();try{return await resultFor(client,f,signal,observed,clock);}catch(err){signal?.throwIfAborted();return null;}};
  if(s.day!==dateKey){s.day=dateKey;s.count=0;}
  if(s.pending){
   const outcomes=[];
   s.pending.timings??={};
   for(const f of s.pending.legs){
    const observation=s.pending.timings[f.eventId]??={kickoffUtc:f.kickoffUtc};
    if(!observation.result&&Date.parse(f.kickoffUtc)<=clock()){
     observation.result=await readResult(f,observation);
     if(observation.result?.void)observation.voidObservedAt??=new Date(clock()).toISOString();
    }
    outcomes.push(observation.result??null);
   }
   const settled=settle(s.pending,outcomes,lane.opening??START);
   if(settled){
    const pending=s.pending,code=pending.code,settledAt=new Date(clock()).toISOString();
    const legReports=pending.legs.map((leg,i)=>learning.explainVirtualLeg(leg,outcomes[i]));
    s.last={...settled,code,timings:pending.timings};s.balance=settled.nextBalance;s.step=settled.nextStep;s.pending=null;s.lastReason=null;
    await save();
    await learning.settleSample(redis,learning.virtualTicketId(lane,code),{status:settled.status.toLowerCase(),settledAt,legs:legReports},new Date(clock())).catch(err=>console.warn('[strategy-learning]',String(err.message).slice(0,160)));
    await send(`ROLL OVER · ${code} · ${settled.status.toUpperCase()}\nReturn: ${money(settled.returned)} · Next stake: ${money(s.balance)}`);
   }else if(pendingCode){
    await save();
    return {reason:'awaiting_settlement',ticketsSent:0};
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
  const board=await fixtures(client,clock(),signal,lane);
  let learned=board;
  try{learned=learning.filterVirtualBoard(board,await learning.readModel(redis),learning.virtualStrategy(lane));}catch(err){console.warn('[strategy-learning]',String(err.message).slice(0,160));}
  const known=new Set([...s.watch,...s.history].map(x=>x.eventId));
  for(const {fixture} of board.slice(0,12))if(!known.has(fixture.eventId))s.watch.push(fixture);
  await save();
  if(s.pending||s.lastSlot===slotKey)return {reason:s.pending?'awaiting_settlement':'already_attempted',ticketsSent:0};
  if(readForm)await addVirtualForm(board,s.history,clock(),signal,readForm);
  const ticket=select(learned.filter(({fixture})=>Date.parse(fixture.kickoffUtc)>clock()+20000),s.history,clock(),new Set(s.used||[]),lane);
  if(!ticket){s.lastReason='no_qualifying_ticket';await save();return {reason:s.lastReason,ticketsSent:0};}
  // Re-read the offered market IDs and prices before creating a share code.
  const refreshed=await fixtures(client,clock(),signal,lane);
  const legs=ticket.legs.map(l=>refreshed.find(x=>x.fixture.eventId===l.eventId)?.rows.find(r=>r.specifier===l.specifier&&r.outcomeId===l.outcomeId&&r.odds===l.odds));
  if(legs.some(x=>!x))return {reason:'prices_changed',ticketsSent:0};
  s.lastSlot=slotKey;
  s.used=[...(s.used||[]),...legs.map(l=>l.eventId)].slice(-120);
  await save();
  const booked=await book(legs);
  const code=String(booked?.shareCode??'');
  if(!/^[A-Za-z0-9]{4,32}$/.test(code)||booked.unavailableOutcomes?.length)throw Error('Roll Over share code not confirmed');
  s.pending={code,legs,odds:ticket.odds,modelProbability:ticket.probability,stake:s.balance,step:s.step};
  s.count++;s.lastReason=null;
  await save();
  await learning.recordSample(redis,learning.virtualSample({lane,code,ticket,legs:ticket.legs,stake:s.pending.stake,step:s.pending.step,openedAt:new Date(clock()).toISOString()}),new Date(clock())).catch(err=>console.warn('[strategy-learning]',String(err.message).slice(0,160)));
  // Persist the code before posting so an ambiguous Telegram response cannot duplicate a pick.
  await check();
  await send(summary(s,lane)+`\nhttps://www.sportybet.com/ng/?shareCode=${code}`);
  return {ticketsSent:1};
 }finally{
  await redis.eval('if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) end',{keys:[lock],arguments:[token]}).catch(()=>{});
 }
}
// Manual checks read the saved form but never advance the scheduled chain.
async function preview(redis,{client=sporty.direct,book=null,clock=Date.now,signal,readForm=configuredForm()}={}){
 const state=await stateOf(redis);
 const now=clock(),rawBoard=await fixtures(client,now,signal);
 let board=rawBoard;
 try{board=learning.filterVirtualBoard(rawBoard,await learning.readModel(redis),learning.virtualStrategy(STANDARD));}catch{}
 if(readForm)await addVirtualForm(board,state.history,now,signal,readForm);
 const notes={statsFixtures:board.filter(x=>x.fixture.formPanel).length,fixtures:board.length,offeredSelections:board.reduce((n,x)=>n+x.rows.length,0),
  verifiedResults:state.history.filter(x=>x.verifiedAt>=now-7*86400000).length};
 const ticket=select(board.filter(x=>Date.parse(x.fixture.kickoffUtc)>clock()+20000),state.history,clock(),new Set(state.used||[]));
 if(!ticket)return {status:'no_ticket',reason:!notes.fixtures?'No upcoming virtual fixtures returned':!notes.offeredSelections?'No supported open totals were found':!notes.verifiedResults&&!notes.statsFixtures?'No verified virtual results saved yet and no usable match Stats panel was read':'No eligible combination met the form and odds requirements',...notes};
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
module.exports={RDP,isRdpVirtualCountry,resetRdpCodeCount,preview,TIMES,run,stateOf,summary,select,settle,fixtures,resultFor,freshState};
