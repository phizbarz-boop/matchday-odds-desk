'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),M=require('../lib/multiPick'),F=require('../lib/telegramFloorPicks');
const now=new Date('2026-11-01T08:00:00Z');
const c=(type='under45',eventId='E',probability=65)=>({eventId,sport:'Football',betType:type,marketId:type,outcomeId:'13',specifier:'total=4.5',odds:1.2,probability,kickoffUtc:'2026-11-01T12:00:00Z',multiQualified:true,multiWinnerGap:.5});
const winners=(gap,eventId='E')=>[{eventId,sport:'Football',marketId:'1',outcomeId:'1',outcomeDesc:'Home',odds:2},{eventId,sport:'Football',marketId:'1',outcomeId:'2',outcomeDesc:'Draw',odds:90},{eventId,sport:'Football',marketId:'1',outcomeId:'3',outcomeDesc:'Away',odds:2+gap}];
test('all Multi rule boundaries use the requested exact ranges',()=>{
 for(const [type,yes,no] of [['away_under45',[1.01,2,5,8],[1,2.01,4.99,8.01]],['home_under45',[0,.5],[.51]],['under45',[0,1],[1.01]],['over05',[8.01,12],[8,7]],['shots_target_under135',[5.01,8],[5,8.01]],['away_offsides_over05',[.51,1],[.5,1.01]],['shots_target_over45',[2,5],[1.99,5.01]],['first5_goals_under05',[0,.5],[.51]]]){for(const g of yes)assert.equal(M.matches(c(type),g),true,type+' '+g);for(const g of no)assert.equal(M.matches(c(type),g),false,type+' '+g);}
});
test('home/away prices exclude draw, missing prices and stale qualification',()=>{
 let rows=M.annotate([c('away_under45')],winners(5));assert.equal(rows[0].multiQualified,true);assert.equal(rows[0].multiWinnerGap,5);
 assert.equal(M.annotate(rows,winners(3))[0].multiQualified,false);assert.equal(M.annotate(rows,[])[0].multiQualified,false);assert.equal(M.annotate([c()],winners(0))[0].multiQualified,true);
});
test('ticket ranks model probabilities without a floor, maximum twenty unique fixtures',()=>{
 const rows=Array.from({length:25},(_,i)=>c('under45','E'+i,i));rows.push({...c('home_under45','E24',99)});
 const result=M.ticket(rows,{now});assert.equal(result.selections.length,20);assert.equal(new Set(result.selections.map(x=>x.eventId)).size,20);assert.equal(result.selections[0].probability,99);assert.ok(result.selections.some(x=>x.probability<70));assert.ok(result.selections.every(x=>M.matches(x,x.multiWinnerGap)));
 assert.equal(M.ticket([{...c(),probability:null}],{now}).selections.length,0);
});
test('daily Multi bypasses retired-market blocks only for matching rules and floor is zero',()=>{
 const plan=F.PLANS.find(p=>p.multi);assert.equal(plan.floor,0);assert.equal(plan.maxGames,20);
 const row={...c('shots_target_under135','E',3),multiWinnerGap:6};assert.equal(F.eligible(row,plan,now,'2026-11-01',new Set()),true);assert.equal(F.eligible({...row,multiWinnerGap:4},plan,now,'2026-11-01',new Set()),false);
 assert.ok(F.PLANS.filter(p=>!p.multi).every(p=>!F.eligible(row,p,now,'2026-11-01',new Set())));
});
test('regeneration changes the exact ticket or reports no available variation',()=>{
 const rows=Array.from({length:22},(_,i)=>c('under45','E'+i,80-i)),first=M.ticket(rows,{now}),signature=require('../lib/ticketVariation').ticketSignature;
 const next=M.ticket(rows,{now,excludedTickets:new Set([signature(first.selections)])});assert.equal(next.selections.length,20);assert.notEqual(signature(next.selections),signature(first.selections));
 assert.equal(M.ticket([rows[0]],{now,excludedTickets:new Set([signature([rows[0]])])}).selections.length,0);
});
test('Telegram fresh gap validation prevents stale Multi booking and successful low-probability code is saved once',async()=>{
 const {fakeRedis}=require('./fixtures/fake-redis'),plan=F.PLANS.find(p=>p.multi);let booked=0,saved=0;
 const deps={plans:[plan],now:()=>now,loadPool:async()=>[c('under45','E',10)],validate:async rows=>M.annotate(rows,winners(2)),book:async()=>{booked++;return{shareCode:'MULTI'}},send:async()=>{},saveCode:async()=>saved++,track:async()=>{},updateTrack:async()=>{}};
 await F.runFloorPicks(deps,{redis:fakeRedis(),dateKey:'2026-11-01',slotKey:'bad',slotTime:'07:00'});assert.equal(booked,0);
 deps.validate=async rows=>M.annotate(rows,winners(.5));const ctx={redis:fakeRedis(),dateKey:'2026-11-01',slotKey:'good',slotTime:'07:00'};await F.runFloorPicks(deps,ctx);await F.runFloorPicks(deps,ctx);assert.equal(booked,1);assert.equal(saved,1);
});
test('website Multi honors requested counts up to fifty while Telegram stays at twenty',()=>{
 const rows=Array.from({length:60},(_,i)=>c('under45','E'+i,80-i/10));
 for(const count of [4,10,20,30,40,50])assert.equal(M.ticket(rows,{now,maxSelections:count}).selections.length,count);
 assert.equal(M.ticket(rows,{now,maxSelections:70}).selections.length,50);
 const plan=F.PLANS.find(p=>p.multi);assert.equal(plan.maxGames,20);assert.equal(F.buildPack(rows,{now}).plans.find(p=>p.multi).selections.length,20);
 const fs=require('node:fs'),html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');const configure=html.split('\n').find(l=>l.startsWith('function configureMulti()'));assert.ok(!configure.includes("getElementById('auto-max').value="));
 const server=fs.readFileSync(require.resolve('../server'),'utf8');assert.ok(server.includes('maxSelections:multiMaxSelections,excludedTickets:excluded'));
});
