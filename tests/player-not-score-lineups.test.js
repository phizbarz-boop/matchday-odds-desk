'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),P=require('../lib/playerNotScore'),M=require('../lib/footballExtraMarkets');
const row=(name='John Defender',extra={})=>({eventId:'e',home:'Home',away:'Away',sport:'Football',kickoffUtc:'2026-11-07T18:00:00Z',marketId:'900',marketDesc:'Player Not to Score',outcomeId:name,outcomeDesc:name,odds:1.08,...extra});
test('explicit negative player list is priced individually without normalizing unrelated players',()=>{
 const rows=[row(),row('Mike Midfielder')],out=require('../lib/offeredMarketModel').modelOfferedMarkets(rows,{minEdge:-100}).candidates;
 assert.equal(out.length,2);assert.equal(out[0].betType,'player_not_to_score');assert.equal(out[0].playerName,'John Defender');assert.equal(out[0].probability,92.6);assert.equal(out[0].independentModel,false);assert.match(out[0].probabilitySource,/single-price/);
 assert.equal(P.singlePriceCandidates([row('John Defender',{marketDesc:'Player to Score'})]).length,0);
 assert.equal(P.singlePriceCandidates([row('None')]).length,0);
 assert.equal(P.singlePriceCandidates([row('John Defender',{suspended:true})]).length,0);
 assert.equal(require('../lib/offeredMarketModel').modelOfferedMarkets(rows,{minProbability:99}).candidates.length,0);
 assert.equal(require('../lib/offeredMarketModel').modelOfferedMarkets(rows,{minEdge:1}).candidates.length,0);
});
test('only a unique confirmed starting player is admitted; role ranks do not change probability',async()=>{
 const rows=P.singlePriceCandidates([row(),row('Mike Midfielder'),row('Alan Attacker'),row('Ben Bench'),row('Unknown')]);const d={};let calls=0;
 const out=await P.enrich(rows,{diagnostics:d,loadLineup:async()=>{calls++;return [{name:'John Defender',position:'CB'},{name:'Mike Midfielder',position:'M'},{name:'Alan Attacker',position:'F'}];}});
 assert.equal(calls,1);assert.equal(out.length,3);assert.equal(out[0].playerPositionRank,0);assert.equal(out[1].playerPositionRank,2);assert.equal(out[0].probability,rows[0].probability);assert.ok(out.every(c=>c.lineupVerified));assert.equal(d.unmatchedPlayers,2);
 assert.equal((await P.enrich(rows,{loadLineup:async()=>[]})).length,0);
 assert.equal((await P.enrich(rows,{loadLineup:async()=>[{name:'John Defender'},{name:'John Defender'}]})).length,0);
});
test('same surname alone and cross-provider numeric IDs never establish player identity',()=>{assert.equal(P.samePlayer('John Smith','James Smith'),false);assert.equal(P.samePlayer('Smith','John Smith'),false);assert.equal(P.samePlayer('J. Smith','John Smith'),true);assert.equal(P.samePlayer('José García','Jose Garcia'),true);assert.equal(P.playerName(row('No',{marketDesc:'John Defender - Player to Score'})),'John Defender');});
test('lineup loader maps both teams and kickoff, uses startXI only, caches date and accepts configured key even if H2H disabled',async()=>{
 const calls=[],env={APISPORTS_KEY:'test',APISPORTS_H2H_ENABLED:'false',APISPORTS_H2H_MINUTE_LIMIT:100};
 const old=globalThis.fetch;globalThis.fetch=async url=>{calls.push(url);return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({errors:[],response:url.includes('/fixtures/lineups')?[{team:{id:1},startXI:[{player:{name:'John Defender',pos:'D'}}],substitutes:[{player:{name:'Ben Bench',pos:'D'}}]}]:[{fixture:{id:42,date:'2026-11-07T18:00:00Z'},teams:{home:{id:1,name:'Home'},away:{id:2,name:'Away'}}}]})};};
 try{const load=await P.lineupLoader({env});const players=await load(row());assert.deepEqual(players.map(x=>x.name),['John Defender']);assert.ok(calls.some(x=>x.includes('/fixtures/lineups?fixture=42')));await load(row());assert.equal(calls.filter(x=>!x.includes('lineups')).length,1);}finally{globalThis.fetch=old;}
});
test('lineup work is bounded and failed data is never treated as confirmed',async()=>{const rows=P.singlePriceCandidates([row('A One'),row('B Two',{eventId:'e2'})]),d={};const out=await P.enrich(rows,{maxFixtures:1,diagnostics:d,loadLineup:async()=>{throw Object.assign(Error('quota'),{code:'API_DAILY_BUDGET'});}});assert.equal(out.length,0);assert.equal(d.scanLimited,1);assert.equal(d.failures.e,'API_DAILY_BUDGET');});
test('builder prefers defenders only after the requested probability floor passes',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),s=fs.readFileSync(require.resolve('../server'),'utf8'),start=s.indexOf('async function prepareAutoCandidatePool('),end=s.indexOf('\n}\n',start)+2;
 let rows=[{...row(),betType:'player_not_to_score',lineupVerified:true,playerPositionRank:0,probability:60},{...row('Mike Midfielder'),betType:'player_not_to_score',lineupVerified:true,playerPositionRank:2,probability:95}];
 const c={normalizeSportScopes:()=>['football'],normalizeLiveMode:x=>x,loadAutoCandidates:async()=>rows,require:name=>name==='./lib/footballExtraMarkets'?M:{checkCandidates:async x=>x},sportyRequest:()=>null,passesRedFlagFilter:()=>true};vm.createContext(c);vm.runInContext(s.slice(start,end)+';this.prepare=prepareAutoCandidatePool;',c);
 assert.equal((await c.prepare({minProbability:70})).candidates[0].playerPositionRank,2);
 rows[0].probability=80;assert.equal((await c.prepare({minProbability:70})).candidates[0].playerPositionRank,0);
});
test('SportyBet team suffixes are stripped only when they identify one of the fixture teams',()=>{assert.equal(P.playerName(row('John Defender (Home)')),'John Defender');assert.equal(P.playerName(row('John Defender (Unrelated)')),'John Defender (Unrelated)');});
test('soonest fixtures are checked first and a daily-budget error stops the remaining upstream calls',async()=>{
 const rows=P.singlePriceCandidates([row('Later Player',{eventId:'later',kickoffUtc:'2026-11-08T18:00:00Z'}),row('Soon Player',{eventId:'soon',kickoffUtc:'2026-11-07T18:00:00Z'})]),calls=[],d={};
 await P.enrich(rows,{diagnostics:d,loadLineup:async c=>{calls.push(c.eventId);throw Object.assign(Error('quota'),{code:'API_DAILY_BUDGET'});}});
 assert.deepEqual(calls,['soon']);assert.equal(d.blockedReason,'API_DAILY_BUDGET');assert.equal(d.fixturesUnavailable,1);assert.equal(d.scanLimited,1);
});

test('initials preserve complete compound surnames without fuzzy surname matching',()=>{assert.equal(P.samePlayer('Morgan Gibbs-White','M. Gibbs-White'),true);assert.equal(P.samePlayer('Callum Hudson-Odoi','C. Hudson-Odoi'),true);assert.equal(P.samePlayer('Callum Hudson-Odoi','C. Hudson'),false);});
