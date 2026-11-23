'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const learning=require('../lib/strategyLearning');
const roll=require('../lib/virtualRollOver');
function redis(){const data=new Map();return {get:async k=>data.get(k)??null,set:async(k,v)=>{data.set(k,v);return 'OK';}};}
function leg(i,status,probability=80){return {eventId:'sr:match:'+i,home:'Home '+i,away:'Away '+i,league:'Virtual Spain',field:'u45',betType:'u45',startingOdds:1.2,modelProbability:probability,status,failed:status==='lost',score:status==='lost'?'4-2':'1-1',reason:status==='lost'?'Under 4.5 lost':'',sport:'Virtual Football'};}
test('settlement keeps the game, starting odds, score, time and why it lost',async()=>{
 const r=redis(),opened=await learning.recordSample(r,learning.virtualSample({lane:roll.RDP,code:'CODE1',ticket:{odds:1.2,probability:0.8,legs:[]},legs:[{eventId:'sr:match:9',home:'MON',away:'RAY',league:'777',odds:1.2,probability:80,field:'u45',pick:'Under 4.5 Goals',marketId:'18',outcomeId:'13',specifier:'total=4.5',kickoffUtc:'2026-11-18T10:00:00Z'}],stake:250000,step:2,openedAt:'2026-11-18T09:00:00Z'}));
 assert.equal(opened.legs[0].startingOdds,1.2);assert.equal(opened.legs[0].eventId,'sr:match:9');
 const lostAt='2026-11-18T10:20:00Z';
 const saved=await learning.settleSample(r,opened.id,{status:'lost',settledAt:lostAt,legs:[learning.explainVirtualLeg(opened.legs[0],{h:4,a:2})]},new Date(lostAt));
 assert.equal(saved.status,'lost');assert.equal(saved.lostAt,lostAt);assert.deepEqual(saved.failedEventIds,['sr:match:9']);
 assert.match(saved.lossReason,/Full-time 4-2 \(6 goals\)/);assert.match(saved.lossReason,/starting odds 1.20/);
 const model=await learning.readModel(r);assert.equal(model.openIds.includes(opened.id),false);
});
test('too few results do not change a decision, and a repeated losing pattern is avoided',()=>{
 const sample=(status,i)=>({id:'s'+i,strategy:'virtual-rollover',status:'lost',legs:[leg(i,status)]});
 assert.equal(learning.decide(learning.train(Array.from({length:7},(_,i)=>sample('lost',i))),{strategy:'virtual-rollover',...leg(1,'lost')}).avoid,false);
 const model=learning.train(Array.from({length:12},(_,i)=>sample('lost',i)));
 const blocked=learning.decide(model,{strategy:'virtual-rollover',...leg(99,'open')});
 assert.equal(blocked.avoid,true);assert.match(blocked.reason,/Avoid/);
 const healthy=learning.train(Array.from({length:12},(_,i)=>sample(i<10?'won':'lost',i)));
 assert.equal(learning.decide(healthy,{strategy:'virtual-rollover',...leg(3,'won')}).factor,1);
 const board=[{fixture:{league:'Virtual Spain'},rows:[{eventId:'sr:match:1',home:'Home 1',away:'Away 1',field:'u45',odds:1.2,probability:80,league:'Virtual Spain'},{eventId:'sr:match:2',home:'Other',away:'Side',field:'o05',odds:1.15,probability:90,league:'Virtual Spain'}]}];
 const filtered=learning.filterVirtualBoard(board,model,'virtual-rollover');
 assert.deepEqual(filtered[0].rows.map(row=>row.field),['o05']);
 assert.equal(learning.filterVirtualBoard(board,learning.train([]),'virtual-rollover'),board);
});
test('daily picks keep the original probability until a market has a bad settled record',()=>{
 const row={eventId:'E',sport:'Football',betType:'under45',odds:1.5,probability:84,fullWinProbability:84,home:'H',away:'A'};
 assert.equal(learning.adjustDailyRows([row],{buckets:{}})[0],row);
 const losses=Array.from({length:12},(_,i)=>({id:'d'+i,strategy:'daily-picks',status:'lost',legs:[{eventId:'E'+i,sport:'Football',betType:'under45',startingOdds:1.5,modelProbability:84,status:'lost',home:'H',away:'A'}]}));
 const model=learning.train(losses);
 const adjusted=learning.adjustDailyRows([row,{...row,eventId:'ok',betType:'home_win',probability:75,fullWinProbability:null}],model);
 assert.equal(adjusted.some(item=>item.betType==='under45'),false);
 assert.equal(adjusted[0].betType,'home_win');assert.equal(adjusted[0].probability,75);
});
test('an empty learning store does not change virtual selection',()=>{
 const now=Date.parse('2026-11-18T10:00:00Z');
 const fixture={eventId:'sr:match:1',home:'MON',away:'RAY',league:'777',kickoffUtc:new Date(now+600000).toISOString()};
 const board=[{fixture,rows:[{...fixture,field:'u45',odds:1.2,probability:70,marketId:'18',outcomeId:'13',specifier:'total=4.5',pick:'Under 4.5'}]}];
 const history=Array.from({length:5},(_,i)=>({eventId:'sr:match:'+(50+i),league:'777',home:'MON',away:'RAY',h:1,a:1,verifiedAt:now-3600000-i}));
 const plain=roll.select(board,history,now);
 const learned=roll.select(learning.filterVirtualBoard(board,null,'virtual-rollover'),history,now);
 assert.equal(plain.legs[0].eventId,learned.legs[0].eventId);assert.equal(plain.odds,learned.odds);
});

test('the one-year team prior is not blocked by the old league lock',()=>{
 const board=[{fixture:{},rows:[
  {field:'u45',league:'Spain League',odds:1.2,probability:70},
  {field:'u55',league:'French League',odds:1.3,probability:70},
  {field:'h35',country:'spain',league:'999',odds:1.4,probability:70},
  {field:'u45',league:'England League',odds:1.2,probability:70},
  {field:'o05',league:'England League',odds:1.2,probability:80},
  {field:'o05',league:'Spain League',odds:1.2,probability:80},
  {field:'h35',league:'Italy League',odds:1.4,probability:70}
 ]}];
 const kept=learning.filterVirtualBoard(board,learning.train([]),'virtual-rollover-rdp')[0].rows.map(row=>row.field+':'+(row.country||row.league));
 assert.deepEqual(kept,['u45:Spain League','u55:French League','h35:spain','u45:England League','o05:England League','o05:Spain League','h35:Italy League']);
});

test('an RDP loss benches that team on that market for the next tickets',()=>{
 const lost={id:'rdp1',strategy:'virtual-rollover-rdp',status:'lost',legs:[{home:'ESP',away:'RAY',field:'u55',status:'lost',startingOdds:1.12,modelProbability:97}]};
 const model=learning.train([lost]);
 const board=[{fixture:{},rows:[
  {field:'u55',home:'ESP',away:'VCF',odds:1.1,probability:97},
  {field:'u45',home:'ESP',away:'VCF',odds:1.2,probability:93},
  {field:'o05',home:'CHE',away:'MUN',odds:1.16,probability:95}
 ]}];
 const kept=learning.filterVirtualBoard(board,model,'virtual-rollover-rdp')[0].rows.map(row=>row.field+':'+row.home);
 assert.deepEqual(kept,['u45:ESP','o05:CHE']);
 const won={id:'rdp2',strategy:'virtual-rollover-rdp',status:'won',legs:[{home:'ESP',away:'VCF',field:'u55',status:'won',startingOdds:1.12,modelProbability:97}]};
 const restored=learning.filterVirtualBoard(board,learning.train([lost,won]),'virtual-rollover-rdp')[0].rows.map(row=>row.field);
 assert.deepEqual(restored,['u55','u45','o05']);
});
