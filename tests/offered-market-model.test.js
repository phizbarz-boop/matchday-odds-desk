const test=require('node:test'),assert=require('node:assert/strict');
const {modelOfferedMarkets}=require('../lib/offeredMarketModel');
const {flattenDetailedMarkets}=require('../lib/sportybet');
const row=(outcomeDesc,outcomeId,extra={})=>({eventId:'e',marketId:'900',specifier:null,odds:2,sport:'Football',home:'Home Team',away:'Away Team',kickoffUtc:'2026-10-12T12:00:00Z',marketDesc:'Player to score',outcomeDesc,outcomeId,marketOutcomeCount:2,...extra});
test('arbitrary yes/no market IDs receive clearly labelled no-vig estimates',()=>{
 const {candidates,coverage}=modelOfferedMarkets([row('Yes','1',{odds:1.5}),row('No','2',{odds:3})]);assert.equal(candidates.length,2);assert.ok(Math.abs(candidates.reduce((n,c)=>n+c.probability,0)-100)<.2);assert.equal(coverage.marketEstimates,1);assert.ok(candidates.every(c=>!c.independentModel&&c.edgeType==='market-adjusted'));
});
test('all half total lines and periods are supported without mixing lines or events',()=>{
 const rows=[row('Over 7.5','o',{specifier:'total=7.5',marketDesc:'1st half cards Over/Under'}),row('Under 7.5','u',{specifier:'total=7.5',marketDesc:'1st half cards Over/Under'}),row('Over 8.5','o',{specifier:'total=8.5',marketDesc:'1st half cards Over/Under'}),row('Under 8.5','u',{specifier:'total=8.5',marketDesc:'1st half cards Over/Under'})];const result=modelOfferedMarkets(rows);assert.equal(result.candidates.length,4);assert.equal(result.coverage.discoveredMarketInstances,2);
});
test('incomplete, integer-line, overlapping and early payout markets are excluded with reasons',()=>{
 for(const rows of [[row('Yes','1')],[row('Over 2','1',{specifier:'total=2',marketDesc:'Total Goals'}),row('Under 2','2',{specifier:'total=2',marketDesc:'Total Goals'})],[row('1X','1',{marketDesc:'Double Chance'}),row('X2','2',{marketDesc:'Double Chance'})],[row('Yes','1',{marketDesc:'1UP'}),row('No','2',{marketDesc:'1UP'})]]){const result=modelOfferedMarkets(rows);assert.equal(result.candidates.length,0);assert.equal(result.coverage.unmodeled,1);assert.ok(result.coverage.markets[0].reason);}
});
test('known model scores are preserved and unknown non-exclusive outcomes cannot be normalized',()=>{
 const rows=[row('Yes','1'),row('No','2')];assert.equal(modelOfferedMarkets(rows,{known:rows}).candidates.length,0);assert.equal(modelOfferedMarkets([row('Any scorer','1'),row('Any scorer 2','2')]).candidates.length,0);
});
test('inactive missing outcomes keep the original count so a partial market cannot gain a high probability',()=>{
 const rows=flattenDetailedMarkets({eventId:'e',homeTeamName:'A',awayTeamName:'B',markets:[{marketId:'900',desc:'Player to score',outcomes:[{id:'1',desc:'Yes',odds:2},{id:'2',desc:'No',odds:2,active:false}]}]});assert.equal(rows[0].marketOutcomeCount,2);assert.equal(modelOfferedMarkets(rows).candidates.length,0);
});
test('complete HT/FT and exact-count partitions are modeled; missing tail is rejected',()=>{
 const rows=['1','X','2'].flatMap(a=>['1','X','2'].map(b=>row(a+'/'+b,a+b,{marketDesc:'Half Time/Full Time',odds:9.1,marketOutcomeCount:9})));
 assert.equal(modelOfferedMarkets(rows).candidates.length,9);
 const counts=['0','1','2+'].map((label,i)=>row(label,String(i),{marketDesc:'Exact total goals',odds:3,marketOutcomeCount:3}));assert.equal(modelOfferedMarkets(counts).candidates.length,3);
 assert.equal(modelOfferedMarkets(counts.slice(0,2)).candidates.length,0);
});
test('extra event-detail markets survive shared candidate generation and fresh booking validation',async()=>{
 const {publicCandidates,validatePublicSelections}=require('../lib/sportyPublicCache');
 const now=new Date('2026-10-11T21:00:00Z');
 const event={eventId:'extra',homeTeamName:'Player A',awayTeamName:'Player B',estimateStartTime:+now+3600000,markets:[{marketId:'901',desc:'1st Set - Odd/Even',outcomes:[{id:'o',desc:'Odd',odds:2},{id:'e',desc:'Even',odds:2}]}]};
 const rows=flattenDetailedMarkets(event,{sport:'Tennis'});
 const pool=await publicCandidates({generatedAt:now.toISOString(),source:'fixture',sports:{tennis:{fixtures:rows.slice(0,1),rows}}});
 assert.equal(pool.length,2);assert.equal(pool[0].betType,'offered:901');
 const valid=await validatePublicSelections([pool[0]],{now:()=>now,client:{fetchEventDetail:async()=>({data:event})}});assert.equal(valid.length,1);assert.equal(valid[0].marketSchema,'odd_even');
});
