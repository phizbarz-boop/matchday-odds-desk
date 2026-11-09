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
