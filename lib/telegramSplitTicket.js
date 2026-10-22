'use strict';
const crypto=require('node:crypto');
const {splitTicket}=require('../public/ticket-split');
const {normalizedSport}=require('./telegramMixedSelector');
async function splitAnalyzedTicket(user,redis,parts,deps){
 if(!redis)throw Error('Persistent storage is required to split tickets.');
 const last=user.lastAnalyzerRequest,plan=deps.getPlan(user);if(!last?.bookingCode)throw Error('Analyze the original booking code first.');if(plan.dailyAnalyzes<=0)throw Error('Code analysis requires a paid plan.');
 const id=crypto.createHash('sha256').update(JSON.stringify([last.bookingCode,last.analyzedAt,parts])).digest('hex');
 const prefix=`telegram:split:${user.telegramId}`,stateKey=prefix+':'+id,lockKey=prefix+':lock',token=crypto.randomUUID();
 if(await redis.set(lockKey,token,{NX:true,EX:900})!=='OK')throw Error('A split is already processing. Wait, then tap the same split size to see its codes.');
 const save=state=>redis.set(stateKey,JSON.stringify(state),{EX:172800});
 try{
  const saved=await redis.get(stateKey);let state=saved?JSON.parse(saved):null;
  if(!state){const analysis=await deps.analyze(last.bookingCode,0,last.horizonDays,false,!!last.includeLive);const groups=splitTicket(analysis.analyzed,parts);
   const allowed=new Set(plan.sports);if(groups.some(g=>g.selections.length>plan.maxSelections||!allowed.has('all')&&g.selections.some(s=>!allowed.has(normalizedSport(s)))))throw Error('These split tickets exceed your plan’s sport or selection limits.');
   const credits=Math.max(0,plan.dailyTickets-Number(user.ticketsUsed||0))+Number(user.extraTickets||0);if(credits<groups.length)throw Error(`This split creates ${groups.length} codes and needs ${groups.length} ticket credits; you have ${credits}.`);
   state={groups:groups.map(g=>({...g,status:'ready'}))};await save(state);
  }
  delete state.error;
  for(const group of state.groups){
   if(group.status==='completed')continue;
   if(group.status!=='ready'){state.error='A previous part has an unconfirmed booking or credit outcome. Existing codes are shown below; this part will not be booked again automatically.';break;}
   if(!deps.hasCredit(user)){state.error='No ticket credits remain. Tap the same split size after adding credits to resume.';break;}
   if(await redis.get(lockKey)!==token)throw Error('Split lease expired. Check the same split size for saved codes.');
   await redis.expire(lockKey,900);group.status='booking';await save(state);
   try{
    const booking=await deps.book(group.selections.map(x=>({eventId:x.eventId,marketId:x.marketId,outcomeId:x.outcomeId,...(x.specifier?{specifier:x.specifier}:{})})));
    if(!booking?.shareCode||booking.unavailableOutcomes?.length)throw Error('SportyBet did not confirm every original selection in this part.');
    group.booking=booking;group.status='credit_pending';await save(state);
    const consumed=await deps.consume(redis,user,'ticket');if(!consumed.ok)throw Error('Ticket credit could not be confirmed.');user=consumed.user;group.status='completed';await save(state);
   }catch(error){state.error=`Part ${group.index}: ${error.message} Check the same split size for saved codes; automatic duplicate booking is blocked.`;await save(state);break;}
  }
  return {user,...state};
 }finally{await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',{keys:[lockKey],arguments:[token]}).catch(()=>{});}
}
module.exports={splitAnalyzedTicket};
