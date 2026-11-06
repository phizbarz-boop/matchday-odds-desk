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
 const f=fixture('only','Basketball',{tournament:'NBA'}),calls=[];
 const result=await scanExpandedMarkets([f,fixture('other','Football'),fixture('live','Basketball',{live:true}),fixture('past','Basketball',{kickoffUtc:now.toISOString()}),fixture('late','Basketball',{kickoffUtc:new Date(+now+25*3600000).toISOString()}),fixture('league','Basketball',{tournament:'CBA'})],{sports:['basketball'],leagues:['NBA'],now:()=>now,client:{fetchEventDetail:async id=>{calls.push(id);return payload(f);}}});
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
test('imported specialty fixtures without kickoff metadata are read and accepted only after fresh details confirm the kickoff',async()=>{
 const f=fixture('imported'),result=await scanExpandedMarkets([{...f,kickoffUtc:null}],{sports:['tennis'],now:()=>now,allowUnknownKickoff:true,client:{fetchEventDetail:async()=>payload(f)}});assert.equal(result.rows.length,2);
 const expired=await scanExpandedMarkets([{...f,eventId:'expired-import',kickoffUtc:null}],{sports:['tennis'],now:()=>now,allowUnknownKickoff:true,client:{fetchEventDetail:async()=>payload({...f,eventId:'expired-import',kickoffUtc:now.toISOString()})}});assert.equal(expired.rows.length,0);
});

test('half scan checks half of eligible fixtures independently of the quick cap',async()=>{
 const fixtures=Array.from({length:70},(_,i)=>fixture(String(i)));
 const tomorrow=fixture('tomorrow','Tennis',{kickoffUtc:'2026-10-12T23:00:00Z'});
 const byId=new Map([...fixtures,tomorrow].map(f=>[f.eventId,f]));
 const result=await scanExpandedMarkets([...fixtures,tomorrow],{sports:['tennis'],now:()=>now,hours:48,halfScan:true,todayOnly:true,env:{SPORTYBET_EXPANDED_MAX_EVENTS:2},client:{fetchEventDetail:async id=>payload(byId.get(id))}});
 assert.equal(result.coverage.discoveredFixtures,70);
 assert.equal(result.coverage.detailReads,35);
 assert.equal(result.coverage.complete,false);
 assert.equal(result.coverage.stopReason,'half_scan_sample');
 assert.equal(result.rows.length,70);
});

test('full discovery keeps successful pages after retrying a timed-out page',async()=>{
 const {listPrematchFixtures}=require('../lib/sportybet');
 const pages=[];
 const result=await withFreshSportyRequest(()=>listPrematchFixtures('football',{client:{
  fetchPrematchPage:async(_sport,page)=>{
   pages.push(page);
   if(page===2)throw Object.assign(Error('timeout'),{code:'SPORTYBET_TIMEOUT'});
   return {data:{total:200,events:Array.from({length:100},(_,i)=>({eventId:'fixture'+i,homeTeamName:'A',awayTeamName:'B',estimateStartTime:+now+3600000}))}};
  }
 }}),{reset:true});
 assert.deepEqual(pages,[1,2,2]);
 assert.equal(result.fixtures.length,100);
 assert.equal(result.coverage.failedPage,2);
});

test('half scan processes fixtures without retaining raw rows and stops at the heap guard',async()=>{
 const fixtures=Array.from({length:8},(_,i)=>fixture('memory'+i));
 const byId=new Map(fixtures.map(f=>[f.eventId,f]));
 const consumed=[];
 const result=await scanExpandedMarkets(fixtures,{sports:['tennis'],now:()=>now,halfScan:true,env:{SPORTYBET_EXPANDED_CONCURRENCY:1},heapLimit:100,heapUsed:()=>consumed.length?80:10,onFixtureRows:rows=>consumed.push(rows.length),client:{fetchEventDetail:async id=>payload(byId.get(id))}});
 assert.deepEqual(consumed,[2]);
 assert.equal(result.rows.length,0);
 assert.equal(result.coverage.detailReads,1);
 assert.equal(result.coverage.stopReason,'memory_limit');
});
