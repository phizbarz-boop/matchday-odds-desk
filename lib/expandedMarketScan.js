'use strict';
const sporty=require('./sportybet');
const {memoSportyRead,sportyRequest,withPublicSportyRequest}=require('./sportyRequest');
const {normalizedSport}=require('./telegramMixedSelector');
async function scanExpandedMarkets(fixtures,{sports,leagues=null,hours=24,env=process.env,client=sporty.direct,now=()=>new Date(),signal=sportyRequest()?.signal}={}){
 const budget=Math.max(100,Math.min(20000,Number(env.SPORTYBET_EXPANDED_SCAN_BUDGET_MS)||10000));
 const perRead=Math.max(50,Math.min(budget,Number(env.SPORTYBET_EXPANDED_DETAIL_TIMEOUT_MS)||3000));
 const maxEvents=Math.max(1,Math.min(200,Number(env.SPORTYBET_EXPANDED_MAX_EVENTS)||64));
 const concurrency=Math.max(1,Math.min(6,Number(env.SPORTYBET_EXPANDED_CONCURRENCY)||4));
 const began=Date.now(),deadline=began+budget,bySport=new Map(),unique=new Map();
 for(const row of fixtures){const sport=normalizedSport(row),kickoff=Date.parse(row.kickoffUtc||'');if(!row.eventId||row.live||!sports.includes(sport)||!Number.isFinite(kickoff)||kickoff<=+now()||kickoff>+now()+hours*3600000||leagues?.length&&!leagues.includes(row.tournament))continue;unique.set(String(row.eventId),row);}
 for(const row of unique.values()){const sport=normalizedSport(row);if(!bySport.has(sport))bySport.set(sport,[]);bySport.get(sport).push(row);}
 for(const group of bySport.values())group.sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc));
 const queue=[];while(queue.length<maxEvents&&[...bySport.values()].some(g=>g.length)){for(const group of bySport.values()){if(group.length&&queue.length<maxEvents)queue.push(group.shift());}}
 const rows=[],errors={};let index=0,read=0,timeouts=0;
 async function worker(){while(index<queue.length&&Date.now()<deadline&&!signal?.aborted){const fixture=queue[index++],id=String(fixture.eventId);const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});let timer;
  try{
   const duration=Math.min(perRead,Math.max(1,deadline-Date.now()));
   const payload=await Promise.race([memoSportyRead('eventDetail|'+id,()=>withPublicSportyRequest(()=>client.fetchEventDetail(id),{signal:controller.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('Expanded market detail timed out'),{code:'EXPANDED_DETAIL_TIMEOUT'}));},duration)})]);
   if(signal?.aborted||Date.now()>deadline)continue;
   const event=sporty.extractUpcomingEvents(payload).events.find(e=>String(e.eventId??e.event_id)===id);
   if(event&&(event.banned===true||sporty.isLiveEvent(event)))continue;
   const fresh=sporty.flattenDetailedMarkets(payload,fixture).filter(r=>!r.live&&Date.parse(r.kickoffUtc)>+now()&&Date.parse(r.kickoffUtc)<=+now()+hours*3600000);
   rows.push(...fresh);read++;
  }catch(error){if(error.code==='EXPANDED_DETAIL_TIMEOUT')timeouts++;errors[id]=String(error.code||'EXPANDED_DETAIL_FAILED');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }}
 await Promise.all(Array.from({length:Math.min(concurrency,queue.length)},worker));
 const complete=index===queue.length&&queue.length===unique.size&&Object.keys(errors).length===0&&!signal?.aborted;
 return {rows,errors,coverage:{source:'current request fixtures',discoveredFixtures:unique.size,selectedFixtures:queue.length,attemptedFixtures:index,detailReads:read,timeoutCount:timeouts,elapsedMilliseconds:Date.now()-began,budgetMilliseconds:budget,complete,partial:!complete}};
}
module.exports={scanExpandedMarkets};
