'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {annotateSmallGap}=require('../lib/telegramSmallGap');
const {PLANS,buildPack,eligible}=require('../lib/telegramFloorPicks');
const now=new Date('2026-10-24T06:00:00Z'),dateKey='2026-10-24';
function winners(gap=.5){return [{eventId:'E',marketId:'1',outcomeId:'1',outcomeDesc:'Home',marketDesc:'1X2',sport:'Football',odds:1.7},{eventId:'E',marketId:'1',outcomeId:'2',outcomeDesc:'Draw',marketDesc:'1X2',sport:'Football',odds:50},{eventId:'E',marketId:'1',outcomeId:'3',outcomeDesc:'Away',marketDesc:'1X2',sport:'Football',odds:1.7+gap}];}
function leg(betType='under45'){return{eventId:'E',sport:'Football',marketId:'18',outcomeId:'13',specifier:'total=4.5',betType,odds:1.25,probability:80,kickoffUtc:'2026-10-24T12:00:00Z'};}
test('six dedicated ticket plans enforce the same gap limit without imposing it on the original combined corners plans',()=>{
 const plans=PLANS.filter(p=>p.winnerGapMaxOne);assert.equal(plans.length,6);
 assert.deepEqual(plans.filter(p=>p.longShot).map(p=>p.maxGames),[30,30,30]);assert.ok(plans.every(p=>p.floor===70));
 const good=annotateSmallGap([leg()],winners())[0];for(const p of plans){const c={...good,betType:p.betTypes[0]};assert.equal(eligible(c,p,now,dateKey,new Set()),true);assert.equal(eligible({...c,winnerGapMaxOneQualified:false},p,now,dateKey,new Set()),false);assert.equal(eligible({...c,probability:69.9},p,now,dateKey,new Set()),false);}
 assert.ok(PLANS.filter(p=>p.id==='corners70short'||p.id==='corners70long').every(p=>!p.winnerGapMaxOne));
});
test('fresh winner prices overwrite saved eligibility and never mix draw, missing sides or other fixtures',()=>{
 const c={...leg(),winnerGapMaxOneQualified:true};
 for(const rows of [[],winners(1.01),winners().slice(0,2),winners().map(r=>({...r,eventId:'other'}))])assert.equal(annotateSmallGap([c],rows)[0].winnerGapMaxOneQualified,false);
 for(const gap of [0,.5,1])assert.equal(annotateSmallGap([c],winners(gap))[0].winnerGapMaxOneQualified,true);
});
test('dedicated Under 4.5 and corner 12.5 plans cannot substitute another total or corner line',()=>{
 const rows=['under45','corners_under125','corners_under115','streak_3_no','streak_3_yes'].map((type,i)=>({...leg(type),eventId:'E'+i,winnerGapMaxOneQualified:true}));
 const plans=buildPack(rows,{now,dateKey}).plans.filter(p=>p.winnerGapMaxOne);
 for(const p of plans){assert.equal(p.selections.length,1);assert.ok(p.selections.every(c=>p.betTypes.includes(c.betType)));}
});
test('booking validation recomputes the gap from freshly returned full-match winner odds',async()=>{
 const {validatePublicSelections}=require('../lib/sportyPublicCache'),{market,outcome}=require('./fixtures/sportybet-live-format');let gap=.5;
 const e=()=>({eventId:'E',homeTeamName:'H',awayTeamName:'A',estimateStartTime:Date.parse(leg().kickoffUtc),status:0,markets:[market('1','1X2',[outcome('1','Home',1.7),outcome('2','Draw',3.5),outcome('3','Away',1.7+gap)]),market('18','Over/Under',[outcome('12','Over 4.5',4),outcome('13','Under 4.5',1.25)],{specifier:'total=4.5'})]});
 const opts={now:()=>now,client:{fetchEventDetail:async()=>({data:e()}),fetchPrematchPage:()=>assert.fail('Detail succeeded')}};
 const old={...leg(),home:'H',away:'A',winnerGapMaxOneQualified:true};let fresh=await validatePublicSelections([old],opts);assert.equal(fresh.length,1);assert.equal(fresh[0].winnerGapMaxOneQualified,true);
 gap=1.1;fresh=await validatePublicSelections([old],opts);assert.equal(fresh.length,1);assert.equal(fresh[0].winnerGapMaxOneQualified,false);
 assert.equal(eligible(fresh[0],PLANS.find(p=>p.id==='footballU4570shortgap'),now,dateKey,new Set()),false);
});
