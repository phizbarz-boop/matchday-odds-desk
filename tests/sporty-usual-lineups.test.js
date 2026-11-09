'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),S=require('../lib/sportyLineups'),P=require('../lib/playerNotScore');
const docs=require('./fixtures/sporty-usual-lineups.json');
const c={eventId:'sr:match:72221382',sport:'Football',home:'Ipswich',away:'Bournemouth',kickoffUtc:'2026-11-08T14:00:00.000Z'};
const parsed=()=>docs.flatMap((d,i)=>S.parseUsual(d,{teamId:i?'60':'32',seasonId:'140756'}));
const cache=()=>{const values=new Map(),queue=new Set();return {values,queue,get:async k=>values.get(k)||null,set:async(k,v)=>values.set(k,v),sAdd:async(k,v)=>queue.add(v),expire:async()=>1,sMembers:async()=>[...queue],sRem:async(k,v)=>queue.delete(v)};};
test('actual captured usual-lineup schema produces 22 names and explicit position ranks, never confirmed starters',()=>{const players=parsed();assert.equal(players.length,22);assert.ok(players.every(p=>p.basis==='usual'&&!p.startingLineupConfirmed));assert.equal(players.find(p=>p.name==='Issa Diop').position,'Central defender');assert.equal(P.role(players.find(p=>p.name==='Issa Diop')),0);assert.equal(P.role(players.find(p=>p.name==='Tyler Adams')),2);assert.equal(S.parseUsual(docs[0],{teamId:'60',seasonId:'140756'}),null);const bad=JSON.parse(JSON.stringify(docs[0]));bad.doc[0].data.players.pop();assert.equal(S.parseUsual(bad,{teamId:'32',seasonId:'140756'}),null);});
test('timeline identity binds team IDs to the requested fixture, both names and kickoff',()=>{const p={queryUrl:'match_timelinedelta/72221382',doc:[{event:'match_timelinedelta',data:{match:{_id:72221382,_sid:1,_seasonid:140756,_dt:{uts:1794146400},teams:{home:{uid:32,name:'Ipswich',mediumname:'Ipswich Town'},away:{uid:60,name:'Bournemouth',mediumname:'AFC Bournemouth'}}}}}]};assert.deepEqual(S.timelineIdentity(p,c),{teams:['32','60'],seasonId:'140756'});assert.equal(S.timelineIdentity(p,{...c,eventId:'sr:match:1'}),null);assert.equal(S.timelineIdentity(p,{...c,home:'Ipswich U19'}),null);assert.equal(S.timelineIdentity(p,{...c,kickoffUtc:'2026-11-09T14:00:00Z'}),null);});
test('website default reads SportyBet cache and queues misses without an API key',async()=>{const redis=cache(),load=await P.lineupLoader({redis,env:{}});await assert.rejects(load(c),{code:'SPORTYBET_USUAL_LINEUP_PENDING'});assert.ok(redis.queue.has(c.eventId));await redis.set(S.dataKey(c),JSON.stringify({...c,basis:'usual',capturedAt:new Date().toISOString(),players:parsed()}));const p=await load(c);assert.equal(p.length,22);assert.ok(p.every(x=>x.provider==='sportybet'));});
test('usual-lineup match admits a player without marking a confirmed starting XI or changing probability',async()=>{const rows=P.singlePriceCandidates([{...c,playerName:'Issa Diop',marketDesc:'Player Not to Score',outcomeDesc:'Issa Diop',marketId:'m',outcomeId:'1',odds:1.06}]);const d={},out=await P.enrich(rows,{loadLineup:async()=>parsed(),diagnostics:d});assert.equal(out.length,1);assert.equal(out[0].lineupBasis,'usual');assert.equal(out[0].startingLineupConfirmed,false);assert.equal(out[0].lineupProvider,'sportybet');assert.equal(out[0].probability,rows[0].probability);assert.equal(d.confirmedStarters,0);assert.equal(d.matchedPlayers,1);});
test('cached evidence is rejected when expired or attached to different teams',()=>{const e={...c,basis:'usual',players:parsed(),capturedAt:new Date(Date.now()-7*3600000).toISOString()};assert.equal(S.usable(e,c),false);e.capturedAt=new Date().toISOString();assert.equal(S.usable(e,{...c,home:'Another'}),false);});
test('worker resumes queued fixtures, saves only validated usual evidence and reuses fresh results',async()=>{const redis=cache();await redis.set(S.fixtureKey(c),JSON.stringify(c));await redis.sAdd(S.QUEUE,c.eventId);let calls=0;const now=()=>Date.parse('2026-11-07T18:00:00Z');const deps={redis,now,discover:async()=>[c],collect:async()=>{calls++;return {...c,basis:'usual',players:parsed(),capturedAt:new Date(now()).toISOString()};},logger:{info(){},warn(){}}};const run=require('../jobs/sporty-lineups-worker').run;assert.equal((await run(deps)).saved,1);assert.equal((await run(deps)).skippedFresh,1);assert.equal(calls,1);assert.equal(redis.queue.size,0);});

test('name matching accepts comma order and preserves compound surnames',()=>{assert.equal(P.samePlayer('Diop, Issa','Issa Diop'),true);assert.equal(P.samePlayer('Van Dijk, Virgil','Virgil Van Dijk'),true);assert.equal(P.samePlayer('Diop, Issa','Moussa Diop'),false);});
test('real prematch discovery output is eligible without a prior website request',async()=>{
 const sporty=require('../lib/sportybet'),redis=cache(),now=Date.parse('2026-11-07T18:00:00Z');
 const listed=await sporty.listPrematchFixtures('football',{client:{fetchPrematchPage:async()=>({data:{totalNum:1,events:[{eventId:c.eventId,homeTeamName:c.home,awayTeamName:c.away,estimateStartTime:Date.parse(c.kickoffUtc)}]}})}});
 assert.equal(listed.fixtures.length,1);assert.equal(listed.fixtures[0].kickoffUtc,c.kickoffUtc);
 const r=await require('../jobs/sporty-lineups-worker').run({redis,now:()=>now,discover:async()=>listed.fixtures,collect:async fixture=>({...fixture,capturedAt:new Date(now).toISOString(),basis:'usual',players:parsed()}),logger:{info(){},warn(){}}});
 assert.equal(r.discoveredFixtures,1);assert.equal(r.eligibleFixtures,1);assert.equal(r.checked,1);assert.equal(r.saved,1);assert.equal(r.missingKickoff,0);
});
test('worker also normalizes legacy start timestamps and reports invalid dates explicitly',async()=>{
 const run=require('../jobs/sporty-lineups-worker').run,now=Date.parse('2026-11-07T18:00:00Z'),fixture={...c,kickoffUtc:null,estimateStartTime:Date.parse(c.kickoffUtc)/1000};
 const r=await run({redis:cache(),now:()=>now,discover:async()=>[fixture],collect:async f=>({...f,capturedAt:new Date(now).toISOString(),basis:'usual',players:parsed()}),logger:{info(){},warn(){}}});assert.equal(r.saved,1);
 const bad=await run({redis:cache(),now:()=>now,discover:async()=>[{...fixture,estimateStartTime:null}],collect:()=>assert.fail('Invalid timestamp must not be read'),logger:{info(){},warn(){}}});assert.equal(bad.status,'invalid_fixture_times');assert.equal(bad.missingKickoff,1);
});
test('collector opens the desktop widget and accepts its locale without exposing request signatures',async()=>{
 const {EventEmitter}=require('node:events'),context=new EventEmitter(),collector=require('../lib/sportyLineupCollector');
 const prefix='https://lmt.fn.sportradar.com/common/en-NG/Africa%3ALagos/gismo/';
 const emit=(path,json)=>context.emit('response',{url:()=>prefix+path+'?T=fixture-test',status:()=>200,headers:()=>({}),json:async()=>json});
 const id='72221382';
 const timeline={queryUrl:'match_timelinedelta/'+id,doc:[{event:'match_timelinedelta',data:{match:{_id:Number(id),_sid:1,_seasonid:140756,_dt:{uts:1794146400},teams:{home:{uid:32,name:'Ipswich'},away:{uid:60,name:'Bournemouth'}}}}}]};
 const page={context:()=>context,goto:async url=>{assert.match(url,/\/ng\/sport\/football\//);return {status:()=>200};},
  locator:selector=>{assert.equal(selector,'#j_title');return {locator:()=>({all:async()=>[{isVisible:async()=>true,evaluate:async()=>true,click:async()=>emit('match_timelinedelta/'+id,timeline)}]})};},
  frames:()=>[{getByText:()=>({all:async()=>[{isVisible:async()=>true,click:async()=>{for(const doc of docs)emit(doc.queryUrl,doc);}}]})}]};
 context.pages=()=>[page];
 const result=await collector.collectPage(page,c,{timeoutMs:1000});
 assert.equal(result.players.length,22);assert.equal(result.startingLineupConfirmed,false);
 assert.ok(!JSON.stringify(result).includes('fixture-test'));
});
test('missing widget data is distinct from a received match mismatch',async()=>{
 const {EventEmitter}=require('node:events'),context=new EventEmitter();
 const page={context:()=>context,goto:async()=>({status:()=>200}),locator:()=>({locator:()=>({all:async()=>[]})}),frames:()=>[]};context.pages=()=>[page];
 await assert.rejects(require('../lib/sportyLineupCollector').collectPage(page,c,{timeoutMs:1}),e=>e.message==='SPORTYBET_LINEUP_TIMELINE_NOT_RECEIVED'&&e.lineupDiagnostics.timelineResponses===0);
});
