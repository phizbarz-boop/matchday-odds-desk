'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assess}=require('../lib/h2hEvidence');
const now=new Date('2026-10-26T14:00:00Z');
const row={eventId:'sr:match:1',home:'Home',away:'Away',sport:'Basketball',marketDesc:'1st Half - Over/Under',betType:'basketball_first_half_over',outcomeDesc:'Over',specifier:'total=82.5',probability:60.4,odds:1.54};
const evidence=(mean,n)=>({...row,capturedAt:now.toISOString(),oldAvailable:true,newAvailable:true,metrics:{points:170,half_points:mean,quarter_points:43},sampleCount:n,games:[]});
test('the eight supplied period selections are classified by their actual historical mean, including small/unreported samples',()=>{
 const cases=[[77.5,82.5,'Over','conflict'],[81,77.5,'Over','aligned'],[89.8,76.5,'Under','conflict'],[87.5,84.5,'Over','aligned'],[81.5,81.5,'Under','inconclusive'],[87.4,77.5,'Over','aligned'],[74,78.5,'Over','conflict'],[72,75.5,'Over','conflict']];
 for(const sample of [null,1,2,4,5,20])for(const [mean,line,side,alignment] of cases){const c={...row,outcomeDesc:side,specifier:'total='+line},r=assess(c,evidence(mean,sample),now);assert.equal(r.h2hCheck.alignment,alignment);assert.equal(r.h2hCheck.allowed,alignment!=='conflict');assert.equal(r.probability,c.probability);assert.equal(r.h2hCheck.mean,mean);assert.equal(r.h2hCheck.metric,'half_points');}
});
test('average 100 supports both Over 90 and Under 110; it rejects Over 110 and Under 90',()=>{
 for(const [side,line,allowed] of [['Over',89.5,true],['Under',110.5,true],['Over',110.5,false],['Under',89.5,false]])assert.equal(assess({...row,outcomeDesc:side,specifier:'total='+line},evidence(100,2),now).h2hCheck.allowed,allowed);
});
test('first-quarter comparison cannot borrow first-half or full-game history and ignores misleading betType identifiers',()=>{
 const c={...row,marketDesc:'1st Quarter - Over/Under',specifier:'total=45.5',betType:'basketball_first_half_over'};
 assert.equal(assess(c,evidence(100,2),now).h2hCheck.allowed,false);
 const e=evidence(100,2);delete e.metrics.quarter_points;const missing=assess(c,e,now);assert.equal(missing.h2hCheck.alignment,'inconclusive');assert.equal(missing.h2hCheck.allowed,true);
 const second=assess({...row,marketDesc:'2nd Half - Over/Under'},evidence(77.5,5),now);assert.equal(second.h2hCheck.status,'checked_no_comparable_metric');
});
test('absent history and nonnumeric metrics never fabricate directional support',()=>{
 assert.equal(assess(row,null,now).h2hCheck.allowed,true);assert.equal(assess(row,evidence(77.5,0),now).h2hCheck.allowed,true);
 for(const mean of [null,undefined,NaN,'77.5',-2]){const r=assess(row,evidence(mean,null),now);assert.equal(r.h2hCheck.allowed,true);assert.notEqual(r.h2hCheck.alignment,'aligned');assert.equal(r.probability,row.probability);}
});
test('Telegram automatic plans exclude a conflicting high-probability period selection',()=>{
 const rows=Array.from({length:11},(_,i)=>{const c={...row,eventId:'sr:match:'+(i+1),probability:80,kickoffUtc:'2026-10-26T18:00:00Z'};return assess(c,{...evidence(i===0?77.5:90,2),eventId:c.eventId},now);});
 const plan=require('../lib/telegramFloorPicks').buildPack(rows,{now}).plans.find(p=>p.id==='basketball70long');assert.equal(plan.selections.length,10);assert.ok(plan.selections.every(c=>c.eventId!=='sr:match:1'));
});
test('a named team total cannot be rejected using a combined match average',()=>{const c={...row,sport:'Football',home:'Sporting',marketDesc:'Sporting Over/Under',outcomeDesc:'Under',specifier:'total=1.5'},e={...evidence(100,10),home:'Sporting',sport:'Football',metrics:{goals:4}};const r=assess(c,e,now);assert.equal(r.h2hCheck.allowed,true);assert.equal(r.h2hCheck.status,'checked_no_comparable_metric');});
