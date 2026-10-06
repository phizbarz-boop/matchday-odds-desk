'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseDisplayedStats,sanitizeStats}=require('../lib/sportyFootballStats');
const {modelFromStats,enrichSportyFixtures,cleanPredictions,noVigProbabilities,MODEL_VERSION}=require('../lib/sportyFootballModel');
const {buildCandidates}=require('../lib/autoPicker');
const {liveState,ongoing,lateStage,winningSideSelection,conditionFootballModel}=require('../lib/liveModel');
const {getFootballMarket,getLiveSportMarket,validateLiveSelections,direct}=require('../lib/sportybet');
const fixture={eventId:'sr:match:880101',home:'Alpha FC',away:'Beta FC',sport:'Football',tournament:'Test',kickoffUtc:new Date(Date.now()+86400000).toISOString()};
const stats={...fixture,capturedAt:new Date().toISOString(),homeGoalsFor:2,homeGoalsAgainst:1,awayGoalsFor:1,awayGoalsAgainst:2};
const row=(id,desc,odds,extra={})=>({...fixture,marketId:'1',marketDesc:'1X2',outcomeId:id,outcomeDesc:desc,odds,...extra});
const response=data=>({ok:true,status:200,headers:{get:k=>k==='content-type'?'application/json':null,getSetCookie:()=>[]},text:async()=>JSON.stringify({data})});

test('parse inspected statistics panel without borrowing unrelated odds',()=>{
 const parsed=parseDisplayedStats('Over/Under\n1.90\nPREVIOUS MEETINGS\n1\n0\n4\nWINS\nDRAWS\nWINS\n1\nSCORED\n3.3\n4\nCONCEDED\n1.3\nTOP SCORERS');
 assert.deepEqual(parsed,{homeGoalsFor:1,awayGoalsFor:3.3,homeGoalsAgainst:4,awayGoalsAgainst:1.3,h2hHomeWins:1,h2hDraws:0,h2hAwayWins:4});
 assert.deepEqual(parseDisplayedStats('1.90\nSCORED\n1.20'),{});
});
test('blank or malformed statistics cannot become zero goal rates',()=>{
 const s=sanitizeStats({...stats,homeGoalsFor:''});assert.equal(s.homeGoalsFor,undefined);
 assert.equal(modelFromStats(fixture,{...stats,homeGoalsFor:''}),null);
 assert.equal(sanitizeStats({...stats,capturedAt:'bad'}),null);
});
test('statistics must match exact fixture and be fresh',()=>{
 assert.equal(modelFromStats(fixture,{...stats,away:'Other'}),null);
 assert.equal(modelFromStats(fixture,{...stats,capturedAt:'2020-01-01'}),null);
 const m=modelFromStats(fixture,stats);assert.ok(m.goalModelAvailable);assert.ok(Math.abs(m.h+m.d+m.a-100)<0.2);assert.equal(m.modelVersion,MODEL_VERSION);
});
test('missing statistics still produce independent real-market candidates without a key',async()=>{
 const rows=[row('1','Home',1.3),row('2','Draw',5),row('3','Away',10)];
 const matches=await enrichSportyFixtures(rows,{statsRows:[],marketRows:rows});
 assert.equal(matches[0].goalModelAvailable,false);
 const c=buildCandidates({predictions:{matches},footballMarkets:{'1x2':{rows}},minProbability:60,minEdge:0,sportScope:'football',betTypes:['home_win']});
 assert.equal(c.length,1);assert.ok(c[0].probability>60);assert.match(c[0].probabilitySource,/no-vig/i);
});
test('complete offered corner pair is restored; half/team corners are excluded',()=>{
 const rows=[row('12','Over 9.5',1.3,{marketId:'777',marketDesc:'Corners Over/Under',specifier:'total=9.5'}),row('13','Under 9.5',4,{marketId:'777',marketDesc:'Corners Over/Under',specifier:'total=9.5'})];
 const c=buildCandidates({predictions:{matches:[]},footballMarkets:{corners:{rows}},minProbability:60,minEdge:0,betTypes:['corners_over'],sportScope:'football'});
 assert.equal(c.length,1);assert.equal(c[0].marketId,'777');assert.equal(c[0].specifier,'total=9.5');
 assert.equal(noVigProbabilities([rows[0]],'corners').size,0);
 assert.equal(noVigProbabilities(rows.map(x=>({...x,marketDesc:'1st Half Home Corners Over/Under'})),'corners').size,0);
});
test('price sets do not mix line, live status or fixture',()=>{
 const r=row('12','Over 2.5',1.5,{marketId:'18',specifier:'total=2.5'});
 for(const partner of [{...r,outcomeId:'13',outcomeDesc:'Under',specifier:'total=3.5'},{...r,outcomeId:'13',outcomeDesc:'Under',live:true},{...r,outcomeId:'13',outcomeDesc:'Under',eventId:'sr:match:9'}])assert.equal(noVigProbabilities([r,partner],'ou25').size,0);
});
test('retired prediction caches are rejected while new models survive',()=>{
 assert.deepEqual(cleanPredictions({matches:[{...fixture,modelVersion:'retired'},{...fixture,modelVersion:MODEL_VERSION}]}).matches.map(x=>x.modelVersion),[MODEL_VERSION]);
});
test('live score/time adjusts final-score probabilities; missing clock uses labelled market estimates',()=>{
 const m=modelFromStats(fixture,stats),live={...fixture,live:true,liveState:{phase:'2nd half',minute:84,homeScore:2,awayScore:0}};
 const conditioned=conditionFootballModel(m,live);
 assert.ok(conditioned.h>m.h);assert.equal(conditioned.o05,100);assert.equal(conditioned.homeO05,100);assert.match(conditioned.dataSource,/live score/);
 assert.equal(conditionFootballModel(m,{...live,liveState:{...live.liveState,minute:null}}).goalModelAvailable,false);
});
test('terminal status wins over stale flags and kickoff alone is excluded',()=>{
 assert.equal(ongoing({live:true,status:'Finished'}),false);assert.equal(ongoing({estimateStartTime:Date.now()-10000}),false);
 assert.equal(ongoing({status:'2nd half',score:'2:1',matchMinute:"83'"}),true);
 assert.deepEqual(liveState({score:'2:1',matchMinute:'90+2'}).minute,92);
});
test('Quick Cash requires late stage, non-tied score, and the selected leader',()=>{
 const r={...row('1','Home',1.2),live:true,betType:'home_win',liveState:{phase:'2nd half',minute:80,homeScore:2,awayScore:1}};
 assert.ok(winningSideSelection(r));assert.equal(winningSideSelection({...r,betType:'away_win'}),false);
 assert.equal(lateStage({...r,liveState:{...r.liveState,minute:60}}),false);
 assert.equal(lateStage({...r,liveState:{...r.liveState,awayScore:2}}),false);
 assert.equal(winningSideSelection({...r,betType:'over25',marketDesc:'Over/Under'}),false);
 assert.ok(lateStage({...r,sport:'Basketball',liveState:{phase:'4th quarter',homeScore:89,awayScore:80}}));
 assert.equal(lateStage({...r,sport:'Basketball',liveState:{phase:'3rd quarter',homeScore:89,awayScore:80}}),false);
});
test('fresh booking rejects finished matches and Quick Cash leader changes',async()=>{
 direct.setFetchForTesting(async()=>response([{eventId:fixture.eventId,homeTeamName:fixture.home,awayTeamName:fixture.away,live:true,status:'2nd half',matchMinute:85,score:'0:1',markets:[{id:'1',desc:'1X2',outcomes:[{id:'1',desc:'Home',odds:5}]}]}]));
 try {const p=await validateLiveSelections([{...row('1','Home',1.2),sport:'football',quickCash:true,betType:'home_win'}],{maxPages:1});assert.equal(p.valid.length,0);assert.equal(p.dropped.length,1);}finally{direct.setFetchForTesting(null);}
 direct.setFetchForTesting(async()=>response([{eventId:fixture.eventId,live:true,status:'Finished',markets:[{id:'1',outcomes:[{id:'1',odds:1.01}]}]}]));
 try {const p=await validateLiveSelections([{...row('1','Home',1.2),sport:'football'}],{maxPages:1});assert.equal(p.valid.length,0);}finally{direct.setFetchForTesting(null);}
});
test('live detail fallback discovers offered corners and retains live score metadata',async()=>{
 direct.setFetchForTesting(async url=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/eventDetail'))return response({eventId:fixture.eventId,markets:[{id:'778',desc:'Corners Over/Under',specifier:'total=9.5',outcomes:[{id:'12',desc:'Over',odds:1.4},{id:'13',desc:'Under',odds:3}]}]});
  return response([{eventId:fixture.eventId,homeTeamName:fixture.home,awayTeamName:fixture.away,live:true,status:'2nd half',matchMinute:82,score:'2:1',markets:[]}]);
 });
 try {const p=await getLiveSportMarket('football','corners',{maxPages:1});assert.equal(p.rows.length,2);assert.ok(p.rows.every(x=>x.live));assert.equal(p.rows[0].liveState.minute,82);}finally{direct.setFetchForTesting(null);}
});
