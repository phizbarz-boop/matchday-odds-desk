'use strict';
const {bestProbabilityTicket,winningProbability,inWindow,ticketText}=require('./telegramNext12h');
const {normalizedSport}=require('./telegramMixedSelector');
const TIMES=Array.from({length:8},(_,i)=>String(i*3).padStart(2,'0')+':00');
const RESERVATIONS='telegram:three-hourly:unsettled:v1';
function buildVariations(pool,{now=new Date(),blocked=new Set()}={}){
 const used=new Set(blocked),plans=[];
 for(let i=0;i<3;i++){
  const choices=['hockey','tennis'].map(sport=>({...bestProbabilityTicket(pool.filter(c=>normalizedSport(c)===sport&&!used.has(String(c.eventId))&&winningProbability(c)>0&&inWindow(c,+now,+now+12*3600000)),100,{maxSelections:40}),sport}));
  const best=choices.filter(p=>p.reachedTarget).sort((a,b)=>b.estimatedWinningProbability-a.estimatedWinningProbability||a.combinedOdds-b.combinedOdds)[0];
  const plan={id:'100'+String.fromCharCode(97+i),label:'3-HOURLY 100x '+String.fromCharCode(65+i),minProbability:0,targetOdds:100,...(best||{selections:[],reachedTarget:false,reason:'target_unreachable'})};
  if(best){plan.label+=' · '+(best.sport==='hockey'?'ICE HOCKEY':'TENNIS');best.selections.forEach(c=>used.add(String(c.eventId)));}plans.push(plan);
 }
 return plans;
}
async function runThreeHourly(deps,context){
 const {redis,slotKey,dateKey,signal,assertLease=async()=>{},shouldAbort=()=>false}=context;
 if(!redis)throw Error('Persistent REDIS_URL is required for three-hourly picks');
 const guard=async()=>{if(signal?.aborted||shouldAbort())throw Error('Three-hourly batch cancelled');await assertLease();};
 await guard();
 const blocked=new Set();
 for(const raw of await redis.hVals(RESERVATIONS)){
  const row=JSON.parse(raw);if(row.settled)continue;
  let settled=false;try{settled=await deps.isSettled(row);}catch{}await guard();
  if(settled)await redis.hSet(RESERVATIONS,String(row.selection.eventId),JSON.stringify({...row,settled:true}));else blocked.add(String(row.selection.eventId));
 }
 const stateKey='telegram:three-hourly:plans:'+slotKey;
 const old=new Map((await redis.hVals(stateKey)).map(raw=>{const p=JSON.parse(raw);return[p.id,p];}));
 let pool,plans;const results=[];
 for(let i=0;i<3;i++){
  const id='100'+String.fromCharCode(97+i),prior=old.get(id);
  if(prior&&['completed','posting','delivery_unknown','booking_started','booking_unknown','no_eligible_games'].includes(prior.status)){results.push({id,skipped:true,reason:prior.status});continue;}
  let booking=prior?.booking,plan=prior?.plan,posting=false,bookStarted=false;
  const state=async(status,extra={})=>redis.hSet(stateKey,id,JSON.stringify({id,status,plan,booking,...extra}));
  try{
   if(!booking){
    if(!pool)pool=await deps.loadPool({signal});await guard();
    plans=buildVariations(pool,{now:deps.now(),blocked});plan=plans[0];plan={...plan,id,label:plan.label.replace('100x A','100x '+String.fromCharCode(65+i))};
    if(!plan.reachedTarget){await state('no_eligible_games');results.push({id,skipped:true,reason:'target_unreachable'});continue;}
    const fresh=await deps.validate(plan.selections,{signal});await guard();
    if(fresh.length!==plan.selections.length||fresh.some(c=>winningProbability(c)<=0||!inWindow(c,+deps.now(),+deps.now()+12*3600000)||normalizedSport(c)!==plan.sport)||new Set(fresh.map(c=>String(c.eventId))).size!==fresh.length||fresh.reduce((n,c)=>n*c.odds,1)+1e-9<100){await state('no_eligible_games');results.push({id,skipped:true,reason:'markets_changed'});continue;}
    plan.selections=fresh;await deps.assertBookingReady();await guard();
    await state('booking_started');
    // Never expire a reservation merely because three hours have passed.
    for(const c of fresh){blocked.add(String(c.eventId));await redis.hSet(RESERVATIONS,String(c.eventId),JSON.stringify({selection:c,slotKey,id,settled:false}));}
    await guard();bookStarted=true;booking=await deps.book(fresh);
    if(!booking?.shareCode||booking.unavailableOutcomes?.length)throw Error('Incomplete SportyBet booking');
    await state('prepared');
    for(const c of fresh)await redis.hSet(RESERVATIONS,String(c.eventId),JSON.stringify({selection:c,slotKey,id,shareCode:booking.shareCode,settled:false}));
   }
   await guard();const odds=plan.selections.reduce((n,c)=>n*c.odds,1),ticketId=`three-hourly:${slotKey}:${id}`;
   await deps.track(redis,{ticketId,label:plan.label,targetOdds:100,combinedOdds:odds,sportScope:plan.sport,selections:plan.selections,shareCode:booking.shareCode,delivery:'prepared'});
   await deps.saveCode(redis,dateKey,slotKey,plan,booking,odds);await state('posting');posting=true;await guard();
   for(const text of ticketText(plan,plan.selections,booking,context)){await guard();await deps.send(text.replace('NEXT 12H ·','EVERY 3H ·'),{signal});}
   await deps.updateTrack(redis,ticketId,{delivery:'posted',postedAt:deps.now().toISOString()});await state('completed');results.push({id,sent:true,shareCode:booking.shareCode,combinedOdds:odds,sport:plan.sport});
  }catch(error){await state(posting?'delivery_unknown':bookStarted&&!booking?'booking_unknown':booking?'prepared':'failed_before_booking').catch(()=>{});results.push({id,error:String(error.message),retryable:!posting&&(!bookStarted||Boolean(booking))});if(signal?.aborted||shouldAbort())throw error;}
 }
 return {ticketsSent:results.filter(r=>r.sent).length,sent:results.some(r=>r.sent),retryable:results.some(r=>r.retryable),results};
}
module.exports={TIMES,RESERVATIONS,buildVariations,runThreeHourly};
