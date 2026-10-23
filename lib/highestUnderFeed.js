'use strict';
const sporty=require('./sportybet');
const {memoSportyRead,sportyRequest}=require('./sportyRequest');
const {MARKET_IDS}=require('./highestUnderMarkets');
async function collectHighestUnderMarkets({sports=Object.keys(MARKET_IDS),hours=168,leagues=null,maxPages=20,client=sporty.direct,now=()=>new Date(),signal=sportyRequest()?.signal}={}){
 const rows=[],errors={},bySport={},generatedAt=now().toISOString();
 for(const sport of sports.filter(s=>MARKET_IDS[s])){let pages=0,total=null,complete=false;const seen=new Set(),eligible=new Set();
  try{for(let page=1;page<=Math.max(1,Math.min(100,maxPages));page++){
   if(signal?.aborted)throw Error('Highest Under collection cancelled');
   const payload=await memoSportyRead('highest-under-feed|'+sport+'|'+page,()=>client.fetchPrematchPage(sporty.SPORT_IDS[sport],page,100,{marketIds:MARKET_IDS[sport].join(',')}));
   const data=sporty.extractUpcomingEvents(payload);pages++;total=data.total??total;let added=0;
   for(const event of data.events){const id=String(event.eventId??event.event_id??'');if(!id||seen.has(id))continue;seen.add(id);added++;if(event.banned===true||sporty.isLiveEvent(event))continue;
    const kickoffUtc=sporty.normalizeOutcome(event).kickoffUtc,t=Date.parse(kickoffUtc||'');if(!Number.isFinite(t)||t<=+now()+60000||t>+now()+Number(hours)*3600000)continue;
    const ctx={...sporty.fixtureContext(event,sporty.SPORT_LABELS[sport]),kickoffUtc};if(leagues?.length&&!leagues.includes(ctx.tournament))continue;eligible.add(id);rows.push(...sporty.flattenDetailedMarkets(event,ctx));
   }
   if(!data.events.length||!added||total!=null&&seen.size>=total||total==null&&data.events.length<100){complete=total==null||seen.size>=total;break;}
  }}catch(error){if(signal?.aborted)throw error;errors[sport]=String(error.code||error.message).slice(0,160);}
  bySport[sport]={pages,listedFixtures:seen.size,eligibleFixtures:eligible.size,complete,upstreamTotal:total};
 }
 if(Object.keys(bySport).length&&Object.keys(errors).length===Object.keys(bySport).length)throw Error('Public highest-Under market feeds are unavailable.');
 const discoveredFixtures=Object.values(bySport).reduce((n,s)=>n+s.eligibleFixtures,0),complete=Object.values(bySport).every(s=>s.complete);
 return {rows,errors,generatedAt,coverage:{source:'SportyBet public highest-Under market feeds',bySport,hours,discoveredFixtures,fixtureReads:discoveredFixtures,detailReads:0,complete,partial:!complete}};
}
module.exports={collectHighestUnderMarkets};
