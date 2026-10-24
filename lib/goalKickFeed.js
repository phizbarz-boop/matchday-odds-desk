'use strict';
const sporty=require('./sportybet');
const {memoSportyRead,sportyRequest}=require('./sportyRequest');
const MARKET_IDS=['900622','900661']; // Verified public SportyBet goal-kick markets.
async function collectFootballStatMarkets({marketIds=MARKET_IDS,source="SportyBet public goal-kick fixture feed",hours=168,leagues=null,maxPages=20,client=sporty.direct,now=()=>new Date(),signal=sportyRequest()?.signal}={}){
 const generatedAt=now().toISOString(),seen=new Set(),rows=[],fixtures=new Set();let pages=0,total=null,complete=false;
 for(let page=1;page<=Math.max(1,Math.min(100,maxPages));page++){
  if(signal?.aborted)throw Error('Goal-kick collection cancelled');
  const payload=await memoSportyRead('football-stat-feed|'+marketIds.join(',')+'|'+page,()=>client.fetchPrematchPage(sporty.SPORT_IDS.football,page,100,{marketIds:marketIds.join(',')}));
  const parsed=sporty.extractUpcomingEvents(payload);pages++;total=parsed.total??total;let added=0;
  for(const event of parsed.events){const id=String(event.eventId??event.event_id??'');if(!id||seen.has(id))continue;seen.add(id);added++;
   if(event.banned===true||sporty.isLiveEvent(event))continue;
   const kickoffUtc=sporty.normalizeOutcome(event).kickoffUtc,t=Date.parse(kickoffUtc||'');if(!Number.isFinite(t)||t<=+now()+60000||t>+now()+Number(hours)*3600000)continue;
   const context={...sporty.fixtureContext(event,'Football'),kickoffUtc};if(leagues?.length&&!leagues.includes(context.tournament))continue;
   fixtures.add(id);rows.push(...sporty.flattenDetailedMarkets(event,context));
  }
  if(!parsed.events.length||!added||total!=null&&seen.size>=total||total==null&&parsed.events.length<100){complete=total==null||seen.size>=total;break;}
 }
 return {rows,errors:{},generatedAt,coverage:{source,hours:Number(hours),marketIds,pages,upstreamTotal:total,listedFixtures:seen.size,discoveredFixtures:fixtures.size,fixtureReads:fixtures.size,detailReads:0,selectedFixtures:fixtures.size,attemptedFixtures:fixtures.size,complete,partial:!complete}};
}
const collectGoalKickMarkets=options=>collectFootballStatMarkets(options);
module.exports={MARKET_IDS,collectGoalKickMarkets,collectFootballStatMarkets};
