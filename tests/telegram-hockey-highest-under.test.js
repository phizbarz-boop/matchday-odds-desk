'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('../lib/telegramHockeyUnder'),F=require('../lib/telegramFloorPicks');
const now=new Date('2026-10-31T08:00:00Z'),plan=F.PLANS.find(p=>p.hockeyHighestUnder);
const row=(line,eventId='E')=>({eventId,sport:'Ice Hockey',marketId:'18',marketDesc:'Over/Under',outcomeId:'13',outcomeDesc:'Under '+line,specifier:'total='+line,betType:'hockey_under',odds:1.2,probability:85,kickoffUtc:'2026-11-01T12:00:00Z'});
test('highest is calculated before range and probability filters, never falling back to a lower line',()=>{
 const raw=[row(6.5),row(7.5),row(8.5)];let c=H.annotate(raw,raw);assert.deepEqual(c.filter(x=>x.hockeyHighestUnderQualified).map(x=>x.specifier),['total=8.5']);
 c=H.annotate(raw,[...raw,row(9.5)]);assert.ok(c.every(x=>!x.hockeyHighestUnderQualified));
 c=H.annotate(raw.map(x=>({...x,probability:x.specifier==='total=8.5'?69:99})),raw);assert.equal(F.buildPack(c,{now}).plans.find(p=>p.id===plan.id).selections.length,0);
});
test('twenty-game cap, 70-percent boundary, future fixtures and one selection per event',()=>{
 const raw=Array.from({length:25},(_,i)=>[row(6.5,'E'+i),row(7.5,'E'+i)]).flat(),c=H.annotate(raw,raw);
 const p=F.buildPack(c,{now}).plans.find(p=>p.id===plan.id);assert.equal(p.maxGames,20);assert.equal(p.selections.length,20);assert.equal(new Set(p.selections.map(x=>x.eventId)).size,20);assert.ok(p.selections.every(x=>x.specifier==='total=7.5'));
 const good={...p.selections[0],probability:70};assert.equal(F.eligible(good,plan,now,'2026-10-31',new Set()),true);assert.equal(F.eligible({...good,probability:69.9},plan,now,'2026-10-31',new Set()),false);
});
test('unsupported scopes, over selections and cached qualification cannot bypass current highest rows',()=>{
 const bad=['1st Period - Over/Under','Home Over/Under','Player Shots on Goal','Handicap'];for(const marketDesc of bad)assert.equal(H.describe({...row(8.5),marketDesc}),null);
 assert.equal(H.describe({...row(8.5),outcomeDesc:'Over 8.5'}),null);
 const prior={...row(7.5),hockeyHighestUnderQualified:true};assert.equal(H.annotate([prior],[row(8.5)])[0].hockeyHighestUnderQualified,false);
 assert.equal(H.annotate([row(8.5)],[{...row(8.5),suspended:true}])[0].hockeyHighestUnderQualified,false);
 assert.ok(F.PLANS.filter(p=>p.longShot&&!p.hockeyHighestUnder).every(p=>!F.eligible({...row(8.5),hockeyHighestUnderQualified:true},p,now,'2026-10-31',new Set())));
});
test('fresh public validation recomputes highest line from actual event market rows',async()=>{
 const {validatePublicSelections}=require('../lib/sportyPublicCache');let highest=8.5;
 const event=()=>({eventId:'E',homeTeamName:'H',awayTeamName:'A',estimateStartTime:Date.parse(row(8.5).kickoffUtc),status:0,markets:[6.5,7.5,highest].map(line=>({id:'18',desc:'Over/Under',specifier:'total='+line,outcomes:[{id:'12',desc:'Over '+line,odds:'5',isActive:1},{id:'13',desc:'Under '+line,odds:'1.2',isActive:1}]}))});
 const opts={now:()=>now,client:{fetchEventDetail:async()=>({data:event()}),fetchPrematchPage:async()=>({data:{events:[]}})}};
 let result=await validatePublicSelections([{...row(8.5),home:'H',away:'A'}],opts);assert.equal(result.length,1);assert.equal(result[0].hockeyHighestUnderQualified,true);
 highest=9.5;result=await validatePublicSelections([{...row(8.5),home:'H',away:'A'}],opts);assert.ok(result.every(x=>!x.hockeyHighestUnderQualified));
});
