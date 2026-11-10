'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../lib/simFootball');
test('SRL feed only accepts future SRL fixtures with complete prices',async()=>{
 const now=Date.parse('2026-11-09T08:00Z');
 const fixture=(eventId,homeTeamName,awayTeamName)=>({eventId,homeTeamName,awayTeamName,estimateStartTime:now+3600000,markets:[{id:'1',outcomes:[{id:'3',odds:4.2},{id:'1',odds:1.9},{id:'2',odds:3.5}]}]});
 const rows=await S.loadFixtures('srl',{now:()=>now,client:{fetchPrematchPage:async()=>({data:{events:[fixture('1','Arsenal','Liverpool'),fixture('2','Arsenal SRL','Liverpool SRL'),{...fixture('3','BHA','AST'),tournament_name:'England Virtual'},{...fixture('4','Arsenal SRL','Liverpool SRL'),estimateStartTime:now}]}})}});
 assert.deepEqual(rows.map(r=>r.eventId),['2']);
 assert.deepEqual(rows[0].odds,[1.9,3.5,4.2]);
});
test('virtual scan requests the virtual sport and books only matching fresh prices',async()=>{
 const now=Date.parse('2026-11-09T08:00Z');
 const fixture=(eventId,sport)=>({eventId,sport,homeTeamName:'A',awayTeamName:'B',estimateStartTime:now+3600000,markets:[{id:'1',outcomes:[{id:'3',odds:4},{id:'1',odds:2},{id:'2',odds:3}]}]});
 const virtual={id:'sr:sport:202120001'};
 const rows=await S.loadFixtures('virtual',{now:()=>now,client:{fetchPrematchPage:async(id)=>{
  assert.equal(id,virtual.id);return {data:{events:[fixture('v1',virtual),fixture('v2',virtual),fixture('regular',{id:'sr:sport:1'})]}};
 }}});
 const r=S.analyse(rows,{mode:'virtual',targetOdds:100,maxSelections:2,minProbability:40,maxMatchOdds:2});
 assert.equal(r.label,'Virtual Football');assert.equal(r.selections.length,2);assert.equal(r.combinedOdds,4);
 assert.ok(r.selections.every(c=>c.marketId==='1'&&c.outcomeId==='1'&&Math.abs(c.probability-100*.5/(.5+1/3+.25))<1e-9));
 assert.equal(S.validateTicket(rows,r.selections,now),true);
 assert.equal(S.validateTicket(rows,[{...r.selections[0],odds:2.05}],now),false);
 assert.equal(S.validateTicket(rows,[{...r.selections[0],eventId:'regular'}],now),false);
 assert.equal(S.validateTicket(rows,[r.selections[0],r.selections[0]],now),false);
 assert.equal(S.validateTicket(rows,r.selections,now+3600000),false);
});

test('rescans skip previously shown fixtures without relaxing filters',()=>{
 const rows=['a','b','c'].map(eventId=>({eventId,marketId:'1',outcomeIds:['1','2','3'],odds:[1.5,4,6]}));
 const settings={mode:'virtual',targetOdds:10,maxSelections:2,minProbability:55};
 const first=S.analyse(rows,settings);
 const excludedEventIds=first.selections.map(x=>x.eventId);
 const next=S.analyse(rows,{...settings,excludedEventIds});
 assert.equal(next.selections.length,1);
 assert.ok(!excludedEventIds.includes(next.selections[0].eventId));
 const empty=S.analyse(rows,{...settings,excludedEventIds:[...excludedEventIds,next.selections[0].eventId]});
 assert.equal(empty.selections.length,0);
 assert.equal(empty.excludedFixtureCount,3);
});

test('SRL fallback finds a league fixture when the general board returns only regular games',async()=>{
 const now=Date.parse('2026-11-09T08:00Z');
 const fixture={eventId:'sr:match:123',homeTeamName:'Home SRL',awayTeamName:'Away SRL',estimateStartTime:now+3600000};
 const calls=[];
 const rows=await S.loadFixtures('srl',{now:()=>now,lite:async()=>[],client:{
  fetchPrematchPage:async(_,page,size,{tournamentId})=>{
   calls.push(tournamentId);
   return {data:{events:tournamentId==='sr:tournament:32215'?[fixture]:[]}};
  },
  fetchEventDetail:async id=>({data:{...fixture,eventId:id,markets:[{market_id:'1',status:0,outcomes:[{outcome_id:'1',price:1.5},{outcome_id:'2',price:4},{outcome_id:'3',price:6}]}]}})
 }});
 assert.ok(calls.includes('sr:tournament:32215'));
 assert.deepEqual(rows.map(x=>x.eventId),[fixture.eventId]);
 assert.deepEqual(rows[0].odds,[1.5,4,6]);
});

test('highest odds only ranks selections that pass the probability floor and odds cap',()=>{
 const rows=[{eventId:'a',marketId:'1',outcomeIds:['1','2','3'],odds:[1.4,5,8]},{eventId:'b',marketId:'1',outcomeIds:['1','2','3'],odds:[2.3,3,4]}];
 const r=S.analyse(rows,{mode:'srl',highestOdds:true,targetOdds:1.1,maxSelections:1,minProbability:40,maxMatchOdds:2.5});
 assert.equal(r.selections[0].odds,2.3);
 assert.ok(r.selections[0].probability>=40);
});
