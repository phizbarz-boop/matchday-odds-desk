'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {discover}=require('../lib/h2hDiscovery'),sporty=require('../lib/sportybet');
const now=()=>Date.parse('2026-10-26T10:00:00Z');
const event=(id,extra={})=>({eventId:'sr:match:'+id,homeTeamName:'Home '+id,awayTeamName:'Away '+id,estimateStartTime:now()+3600000,status:0,...extra});
const envelope=(events,total=events.length)=>({bizCode:10000,data:{totalNum:total,tournaments:[{name:'League',events}]}});
test('cold discovery reads football and basketball only anonymously and queues fixture identities without event-detail requests',async()=>{
 const calls=[],rows=[];const result=await discover({now,logger:{},client:{fetchPrematchPage:async(id,page,size,options)=>{assert.equal(require('../lib/sportyRequest').sportyRequest().anonymous,true);const sport=Object.keys(sporty.SPORT_IDS).find(s=>sporty.SPORT_IDS[s]===id);assert.equal(options.marketIds,sporty.marketIdsForSport(sport));assert.ok(options.marketIds.length>0,'SportyBet rejects list requests without market IDs');calls.push(id);return envelope([event(calls.length)]);}},onFixtures:async fixtures=>rows.push(...fixtures)});
 assert.deepEqual(calls,[sporty.SPORT_IDS.football,sporty.SPORT_IDS.basketball]);assert.equal(rows.length,2);assert.deepEqual(new Set(rows.map(c=>c.sport)),new Set([sporty.SPORT_LABELS.football,sporty.SPORT_LABELS.basketball]));
 assert.ok(Object.values(result).every(s=>s.complete&&s.nextPage===1));
});
test('discovery retains progress across capped runs and retries the failed sport without preventing other sports',async()=>{
 const result=await discover({now,startPages:{football:3},maxPages:1,logger:{},client:{fetchPrematchPage:async(id,page)=>{if(id===sporty.SPORT_IDS.basketball)throw Object.assign(Error('private upstream response'),{status:422,code:'SPORTYBET_HTTP'});return envelope([event(page)],1000);}}});
 assert.equal(result.football.nextPage,4);assert.equal(result.football.error,'discovery_page_limit');assert.equal(result.basketball.upstreamStatus,422);assert.equal(result.basketball.errorCode,'SPORTYBET_HTTP');assert.ok(!JSON.stringify(result).includes('private upstream response'));assert.equal(result.basketball.nextPage,1);assert.equal(result.basketball.error,'public_fixture_read_failed');assert.equal(result.football.fixtures,1);
});
test('discovery excludes past, live, invalid and beyond-seven-day fixtures',async()=>{
 const rows=[];await discover({now,logger:{},client:{fetchPrematchPage:async()=>envelope([event(1),event(2,{estimateStartTime:now()-1}),event(3,{status:1,matchStatus:'Live'}),event(4,{estimateStartTime:now()+8*86400000}),event(5,{eventId:'invalid'})])},onFixtures:async x=>rows.push(...x)});
 assert.equal(rows.length,2);assert.ok(rows.every(c=>c.eventId==='sr:match:1'));
});
