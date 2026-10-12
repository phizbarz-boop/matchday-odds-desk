const test=require('node:test'),assert=require('node:assert/strict');
const {scanExpandedMarkets}=require('../lib/expandedMarketScan');
const {withFreshSportyRequest,memoSportyRead}=require('../lib/sportyRequest');
const now=new Date('2026-10-12T09:00:00Z');
const fixture=(id,sport='Tennis',extra={})=>({eventId:id,sport,home:'A',away:'B',kickoffUtc:new Date(+now+3600000).toISOString(),...extra});
const payload=f=>({data:{eventId:f.eventId,homeTeamName:f.home,awayTeamName:f.away,estimateStartTime:Date.parse(f.kickoffUtc),markets:[{marketId:'900',desc:'Odd/Even',outcomes:[{id:'o',desc:'Odd',odds:2},{id:'e',desc:'Even',odds:2}]}]}});
test('extra scan makes no list requests and reuses event details already read by the same request',async()=>{
 const f=fixture('reuse'),calls=[];
 const result=await withFreshSportyRequest(async()=>{await memoSportyRead('eventDetail|reuse',async()=>payload(f));return scanExpandedMarkets([f,f],{sports:['tennis'],now:()=>now,client:{fetchEventDetail:async id=>{calls.push(id);return payload(f);},fetchPrematchPage:()=>assert.fail('No second list scan')}});},{reset:true});
 assert.equal(calls.length,0);assert.equal(result.rows.length,2);assert.equal(result.coverage.discoveredFixtures,1);assert.equal(result.coverage.complete,true);
});
test('filters requested sports, leagues, live, expired and outside-horizon fixtures before requesting',async()=>{
 const f=fixture('only','Tennis',{tournament:'ATP'}),calls=[];
 const result=await scanExpandedMarkets([f,fixture('other','Football'),fixture('live','Tennis',{live:true}),fixture('past','Tennis',{kickoffUtc:now.toISOString()}),fixture('late','Tennis',{kickoffUtc:new Date(+now+25*3600000).toISOString()}),fixture('league','Tennis',{tournament:'WTA'})],{sports:['tennis'],leagues:['ATP'],now:()=>now,client:{fetchEventDetail:async id=>{calls.push(id);return payload(f);}}});
 assert.deepEqual(calls,['only']);assert.equal(result.rows.length,2);
});
test('a hanging detail is bounded, aborted and reported without dropping successful rows',async()=>{
 let aborted=false;const {sportyRequest}=require('../lib/sportyRequest'),f=fixture('fast');
 const began=Date.now();const result=await scanExpandedMarkets([f,fixture('hang')],{sports:['tennis'],now:()=>now,env:{SPORTYBET_EXPANDED_SCAN_BUDGET_MS:120,SPORTYBET_EXPANDED_DETAIL_TIMEOUT_MS:60},client:{fetchEventDetail:async id=>{if(id==='fast')return payload(f);sportyRequest().signal.addEventListener('abort',()=>{aborted=true});return new Promise(()=>{});}}});
 assert.ok(Date.now()-began<1000);assert.equal(aborted,true);assert.equal(result.rows.length,2);assert.equal(result.coverage.partial,true);assert.equal(result.coverage.timeoutCount,1);
});
test('fixture cap distributes reads across selected sports and reports partial coverage',async()=>{
 const rows=[fixture('t1'),fixture('t2'),fixture('h1','Ice Hockey'),fixture('h2','Ice Hockey')],calls=[];
 const result=await scanExpandedMarkets(rows,{sports:['tennis','hockey'],now:()=>now,env:{SPORTYBET_EXPANDED_MAX_EVENTS:2},client:{fetchEventDetail:async id=>{calls.push(id);return payload(rows.find(f=>f.eventId===id));}}});
 assert.deepEqual(new Set(calls),new Set(['t1','h1']));assert.equal(result.coverage.partial,true);assert.equal(result.coverage.discoveredFixtures,4);
});
