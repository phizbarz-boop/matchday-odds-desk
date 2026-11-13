'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../lib/telegramFloorPicks'),T=require('../lib/todayLongShots');
const now=new Date('2026-11-05T06:00:00Z'),dateKey='2026-11-05';
const rows=Array.from({length:48},(_,i)=>({eventId:'E'+i,marketId:'1',outcomeId:'1',betType:'home_win',sport:'Football',kickoffUtc:new Date(+now+(60+i*10)*60000).toISOString(),odds:1.32,probability:70}));
test('100k can use more than 30 distinct fixtures, with highest qualifying odds and chronological output',()=>{
 const best={...rows[0],odds:2},invalid={...rows[1],eventId:'low',odds:2,probability:69.99};
 const tomorrow={...best,eventId:'tomorrow',kickoffUtc:'2026-11-05T23:00:00Z'};
 const [plan]=F.buildPack([...rows,best,invalid,tomorrow],{now,dateKey,plans:T.PLANS}).plans;
 assert.ok(plan.selections.length>30&&plan.selections.length<=50);
 assert.equal(plan.selections[0],best);
 assert.ok(plan.selections.every((c,i,a)=>c.probability>=70&&c!==tomorrow&&(!i||a[i-1].kickoffUtc<=c.kickoffUtc)));
 assert.equal(new Set(plan.selections.map(c=>c.eventId)).size,plan.selections.length);
 assert.ok(plan.selections.reduce((x,c)=>x*c.odds,1)>=100000);
});
test('100k falls back above 1,000x and skips when refreshed probabilities fail',async()=>{
 assert.equal(F.buildPack(rows.slice(0,35),{now,dateKey,plans:T.PLANS}).plans[0].selections.length,35);
 const {fakeRedis}=require('./fixtures/fake-redis');
 const deps={plans:T.PLANS,now:()=>now,loadPool:async()=>rows,validate:async x=>x.map(c=>({...c,probability:69})),book:async()=>assert.fail('No booking'),send:async()=>{}};
 const result=await F.runFloorPicks(deps,{redis:fakeRedis(),dateKey,slotKey:'test',slotTime:'07:00',manualTest:true});
 assert.equal(result.ticketsSent,0);
});
test('original finish deadline and market exclusions still apply',()=>{
 const c=rows[0];
 assert.ok(T.eligible({...c,scheduledEndUtc:'2026-11-06T22:59:00Z'},now,dateKey));
 assert.ok(!T.eligible({...c,scheduledEndUtc:'2026-11-06T23:00:00Z'},now,dateKey));
 assert.ok(!T.eligible({...c,marketDesc:'Exact Match Score'},now,dateKey));
 assert.ok(!T.eligible({...c,odds:2.01},now,dateKey));
});
