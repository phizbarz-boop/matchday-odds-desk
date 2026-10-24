'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {collectStreakGoalCandidates}=require('../lib/streakGoalFeed');
const {withPublicSportyRequest}=require('../lib/sportyRequest');
const {scoreMatrix}=require('../lib/model');
const now=new Date('2026-10-24T06:00:00Z');
function outcome(id,desc,odds){return{id,desc,odds};}
function market(id,desc,outcomes,specifier=''){return{id,desc,outcomes,specifier};}
function calibration(){const matrix=scoreMatrix(1.5,1,30);let home=0,draw=0,away=0,over=0;for(let h=0;h<matrix.length;h++)for(let a=0;a<matrix[h].length;a++){const p=matrix[h][a];if(h>a)home+=p;else if(h===a)draw+=p;else away+=p;if(h+a>2)over+=p;}return [market('1','1X2',[outcome('1','Home',1/(home*1.03)),outcome('2','Draw',1/(draw*1.03)),outcome('3','Away',1/(away*1.03))]),market('18','Over/Under',[outcome('12','Over 2.5',1/(over*1.03)),outcome('13','Under 2.5',1/((1-over)*1.03))],'total=2.5')];}
function streak(){return market('60020','Any Team To Score 3 or More Goals in a Row',[outcome('74','Yes',4),outcome('76','No',1.25)]);}
async function collect(markets,extra={}){
 let calls=0;const candidates=await withPublicSportyRequest(()=>collectStreakGoalCandidates({now:()=>now,hours:168,...extra,client:{fetchPrematchPage:async(sport,page,size,opts)=>{calls++;assert.equal(opts.marketIds,'1,18,60020');return{data:{totalNum:1,events:[{eventId:'sr:match:streak-test',homeTeamName:'H',awayTeamName:'A',estimateStartTime:+now+3600000,markets}]}};},fetchEventDetail:()=>assert.fail('Bulk source must not depend on event-detail probes')}}));assert.equal(calls,1);return candidates;
}
test('dedicated public feed fits the existing goal-order model and retains exact No booking identity',async()=>{
 const candidates=await collect([...calibration(),streak()]);assert.equal(candidates.length,1);const c=candidates[0];assert.equal(c.betType,'streak_3_no');assert.equal(c.marketId,'60020');assert.equal(c.outcomeId,'76');assert.equal(c.modelBasis,'market_calibrated_poisson');assert.ok(c.probability>=70);assert.equal(candidates.marketCoverage.scan.detailReads,0);
});
test('uncalibrated matches use only complete current streak price pairs and obey the floor',async()=>{
 const candidates=await collect([streak()]);assert.equal(candidates.length,1);assert.equal(candidates[0].modelBasis,'offered_prices');assert.equal(candidates[0].probability,76.2);
 const incomplete=streak();incomplete.outcomes=incomplete.outcomes.slice(1);assert.equal((await collect([incomplete])).length,0);
 assert.equal((await collect([streak()],{minProbability:80})).length,0);
});
