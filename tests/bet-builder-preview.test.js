'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {preview}=require('../lib/betBuilderPreview');
const now=Date.parse('2026-11-10T10:00Z');
const base={eventId:'a',sport:'Football',kickoffUtc:'2026-11-10T13:00Z',odds:1.5,marketId:'1',outcomeId:'1',betType:'home_win',probability:75};
const goals={...base,marketId:'18',outcomeId:'12',betType:'over15',probability:80};
test('groups one result and one goal market per match, then ranks distinct fixtures',()=>{
 const rows=[base,goals,{...base,eventId:'b'},{...goals,eventId:'b',probability:85},{...goals,probability:98,marketId:'1'}];
 const p=preview(rows,{now,minProbability:70,maxMatches:1});
 assert.equal(p.candidateMatches,2);
 assert.equal(p.builders[0].eventId,'b');
 assert.equal(p.builders[0].modelLowerBound,60);
 assert.deepEqual(p.builders[0].selections.map(c=>c.betType),['home_win','over15']);
 assert.equal('combinedOdds' in p,false);
});
test('requires both eligible legs and never pairs different events or two result picks',()=>{
 for(const rows of [[base,{...goals,probability:60}],[base,{...goals,eventId:'b'}],[base,{...goals,live:true}],[base,{...base,betType:'away_win'}],[base,{...goals,betType:'streak_2_yes'}]]){
  assert.equal(preview(rows,{now,minProbability:70}).builders.length,0);
 }
});
test('quotes exactly two same-match legs, rejects invalid responses and combines only quoted groups',async()=>{
 const {quotePreview}=require('../lib/betBuilderPreview');
 const rows=[11,22,33].flatMap(id=>[base,{...goals,specifier:'total=1.5'}].map(c=>({...c,eventId:'sr:match:'+id})));
 const result=await quotePreview(rows,{now,minProbability:70,targetOdds:5},async request=>{
  assert.equal(request.selections.length,2);
  assert.equal(request.odds,request.selections[0].odds);
  assert.deepEqual(request.latestSelection,request.selections[1]);
  assert.equal(request.selections[1].id,'uof:3/sr:sport:1/18/12?total=1.5');
  return {bizCode:10000,data:request.eventId==='sr:match:22'?{valid:false,odds:'8'}:{valid:true,odds:'2.50'}};
 });
 assert.equal(result.failures,0);
 assert.equal(result.invalid,1);
 assert.equal(result.builders.length,2);
 assert.equal(result.combinedOdds,6.25);
 assert.equal(result.targetReached,true);
});

test('allows match goals with team goals without requiring a match result',()=>{
 const rows=[goals,{...goals,marketId:'19',betType:'home_over05'}];
 assert.equal(preview(rows,{now,minProbability:70}).builders.length,1);
});
test('shares one synthetic selection per match and requires exact lookup confirmation',async()=>{
 const {bookGroups}=require('../lib/betBuilderPreview');
 const groups=[1,2].map(id=>({eventId:'sr:match:'+id,marketId:'261110073951bb2352207'+id,outcomeId:'1',children:[{marketId:'1',outcomeId:'1'},{marketId:'18',outcomeId:'12',specifier:'total=1.5'}]}));
 const wire=groups.flatMap(({eventId,marketId,outcomeId,children})=>[...children.map(c=>({eventId,...c,parentBetBuilderMarketId:marketId})),{eventId,marketId,outcomeId}]);
 let calls=0;
 const bookBet=async rows=>{calls++;assert.deepEqual(rows,wire);return {shareCode:'TEST01'};};
 const result=await bookGroups(groups,{bookBet,getBooking:async(code,options)=>{
  assert.equal(code,'TEST01');assert.equal(options.fresh,true);
  return {ticket:{selections:wire}};
 }});
 assert.equal(result.shareCode,'TEST01');
 await assert.rejects(bookGroups(groups,{bookBet,getBooking:async()=>({ticket:{selections:wire.slice(0,3)}})}),{code:'BET_BUILDER_UNCONFIRMED',bookingOutcomeUnknown:true});
 await assert.rejects(bookGroups([groups[0],groups[0]],{bookBet}),/valid SportyBet group quotes/);
 assert.equal(calls,2);
});
