'use strict';
const {selectionKey}=require('./sportyPublicCache');
const ID='mixedWinnersEarly5';
const LABEL='MIXED WINNERS · EARLIEST KICKOFFS · 5x TARGET';
const TARGET=5;
function prefix(rows){
 let odds=1;
 for(let i=0;i<rows.length;i++){
  const price=Number(rows[i].odds);
  if(!Number.isFinite(price)||price<=1)return [];
  odds*=price;
  if(odds+1e-9>=TARGET)return rows.slice(0,i+1);
 }
 return [];
}
async function run({deps,ctx,states,stateKey,activePlans,check,eligible}){
 const {redis,dateKey,slotKey,signal,manualTest}=ctx;
 const previous=states.find(s=>s.id===ID);
 if(previous&&['completed','posting','booking','unknown','empty'].includes(previous.status))return {id:ID,skipped:true,reason:previous.status};
 const source=states.find(s=>s.id==='mixedWinners70');
 const plan=activePlans.find(p=>p.id==='mixedWinners70');
 if(!plan||source?.status!=='completed'||!activePlans.every(p=>states.some(s=>s.id===p.id&&['completed','empty'].includes(s.status))))return null;
 const save=async(status,extra={})=>{await redis.hSet(stateKey,ID,JSON.stringify({id:ID,status,...extra}));await redis.expire(stateKey,172800);};
 let uncertain=false,selections=[];
 try{
  const ordered=[...(source.selections||[])].sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc));
  if(ordered.some(c=>!Number.isFinite(Date.parse(c.kickoffUtc)))||!prefix(ordered).length){await save('empty');return {id:ID,skipped:true,reason:'source_below_target'};}
  const fresh=new Map((await deps.validate(ordered,{signal,plan})).map(c=>[selectionKey(c),c]));
  await check();
  const current=ordered.map(original=>({original,fresh:fresh.get(selectionKey(original))}));
  const changed=current.some(({original,fresh})=>fresh&&Date.parse(fresh.kickoffUtc)!==Date.parse(original.kickoffUtc));
  if(changed&&current.some(row=>!row.fresh)){
   await save('empty');return {id:ID,skipped:true,reason:'kickoff_order_unconfirmed'};
  }
  if(changed)current.sort((a,b)=>Date.parse(a.fresh.kickoffUtc)-Date.parse(b.fresh.kickoffUtc));
  const consecutive=[];
  for(const {fresh:c} of current){
   if(!c||!eligible(c,plan,deps.now(),dateKey,new Set()))break;
   consecutive.push(c);
  }
  selections=prefix(consecutive);
  if(!selections.length){await save('empty');return {id:ID,skipped:true,reason:'fresh_prefix_below_target'};}
  const combinedOdds=selections.reduce((n,c)=>n*Number(c.odds),1);
  await check();await save('booking',{selections});uncertain=true;
  const booking=await deps.book(selections);
  await check();
  if(!booking?.shareCode||booking.unavailableOutcomes?.length)throw Error('Complete SportyBet booking code not confirmed');
  const ticketId=`floor:${slotKey}:${ID}`;
  await deps.saveCode(redis,dateKey,{targetOdds:`${LABEL} · ${ctx.slotTime} WAT`,combinedOdds,shareCode:booking.shareCode,generatedAt:deps.now().toISOString()});
  await deps.track(redis,{ticketId,label:LABEL,targetOdds:TARGET,combinedOdds,sportScope:'all',minProbability:plan.floor,selections,shareCode:booking.shareCode,shareURL:booking.shareURL,delivery:'prepared',liveMode:'prematch'});
  await save('posting',{selections,shareCode:booking.shareCode});
  await check();
  await deps.send(`${manualTest?'MANUAL TEST · ':''}${LABEL} · ${ctx.slotTime} WAT\n${booking.shareCode} · ${combinedOdds.toFixed(2)} odds${booking.shareURL?'\n'+booking.shareURL:''}\n${selections.length} games · earliest kickoffs from ${source.shareCode}`,{signal});
  await deps.updateTrack(redis,ticketId,{delivery:'posted',postedAt:deps.now().toISOString()});
  await save('completed',{selections,shareCode:booking.shareCode});
  return {id:ID,sent:true,shareCode:booking.shareCode,combinedOdds};
 }catch(error){
  await save(uncertain?'unknown':'failed',{selections,error:String(error.message).slice(0,180)});
  if(signal?.aborted||ctx.shouldAbort?.())throw error;
  return {id:ID,error:uncertain?'Booking or delivery outcome unconfirmed; automatic duplicate suppressed.':String(error.message),retryable:!uncertain};
 }
}
module.exports={run,prefix};
