'use strict';
// Independent public fixture discovery: no user analysis, dummy login, model or
// large market-detail refresh is needed before the history worker can start.
async function discover({client=require('./sportybet').direct,now=Date.now,signal,maxPages=50,startPages={},onFixtures=async()=>{},logger=console}={}){
 const sporty=require('./sportybet'),sports=Object.keys(sporty.SPORT_IDS).filter(s=>require('./h2hScope').enabled({sport:s})),state=Object.fromEntries(sports.map(s=>[s,{pages:0,fixtures:0,complete:false,error:null,nextPage:Math.max(1,Number(startPages[s])||1),seen:new Set()}]));
 await require('./sportyRequest').withPublicSportyRequest(async()=>{
  for(let page=1;page<=maxPages&&!signal?.aborted;page++)for(const sport of sports){
   const st=state[sport];if(st.complete||st.error||signal?.aborted)continue;
   try{
    const pageNumber=st.nextPage;const parsed=sporty.extractUpcomingEvents(await client.fetchPrematchPage(sporty.SPORT_IDS[sport],pageNumber,100,{marketIds:sporty.marketIdsForSport(sport)}));st.pages++;let added=0;const fixtures=[];
    for(const e of parsed.events){const id=String(e.eventId??e.event_id??'');if(st.seen.has(id))continue;st.seen.add(id);added++;
     if(!/^sr:match:\d+$/.test(id)||sporty.isLiveEvent(e)||e.banned===true)continue;
     const c=sporty.fixtureContext(e,sporty.SPORT_LABELS[sport]),kickoffUtc=sporty.normalizeOutcome(e).kickoffUtc,kickoff=Date.parse(kickoffUtc);
     if(!c.home||!c.away||!Number.isFinite(kickoff)||kickoff<=now()||kickoff>now()+7*86400000)continue;
     const label=v=>v&&typeof v==='object'?String(v.name||''):String(v||'');
     fixtures.push({...c,category:label(c.category),tournament:label(c.tournament),sportKey:sport,kickoffUtc});
    }
    st.fixtures+=fixtures.length;if(fixtures.length)await onFixtures(fixtures);
    st.complete=!parsed.events.length||!added||(parsed.total?pageNumber*100>=parsed.total:parsed.events.length<100);
   st.nextPage=st.complete?1:pageNumber+1;
   }catch(error){st.error=signal?.aborted?'discovery_time_budget':'public_fixture_read_failed';if(Number.isInteger(Number(error.status))&&Number(error.status)>=400&&Number(error.status)<=599)st.upstreamStatus=Number(error.status);if(/^[A-Z_]{1,80}$/.test(String(error.code||'')))st.errorCode=String(error.code);}
  }
 },{signal});
 const result=Object.fromEntries(Object.entries(state).map(([sport,{seen,...st}])=>[sport,{...st,...(!st.complete&&!st.error?{error:signal?.aborted?'discovery_time_budget':'discovery_page_limit'}:{})}]));
 logger.info?.('[H2H public discovery] '+JSON.stringify(result));return result;
}
module.exports={discover};
