const test=require('node:test'),assert=require('node:assert/strict');
const {fakeRedis}=require('./fixtures/fake-redis');
const {buildVariations,runThreeHourly,RESERVATIONS,TIMES}=require('../lib/telegramThreeHourly');
const now=new Date('2026-10-09T08:00:00Z');
const leg=(id,sport='hockey',probability=50)=>({eventId:id,sport,marketId:'1',outcomeId:'1',betType:sport+'_winner',odds:100,probability,home:'A',away:'B',kickoffUtc:new Date(+now+3600000).toISOString()});
test('three pure-sport variations choose best combined chance without a floor or repeated fixtures',()=>{
 const pool=[leg('h1','hockey',60),leg('t1','tennis',65),leg('h2','hockey',55),leg('football','football',99)];
 const plans=buildVariations(pool,{now});assert.equal(plans.length,3);assert.deepEqual(plans.map(p=>p.selections[0].eventId),['t1','h1','h2']);assert.ok(plans.every(p=>p.reachedTarget&&p.minProbability===0));
});
test('schedule is every three hours in WAT; blocked and live fixtures are excluded',()=>{
 assert.deepEqual(TIMES,['00:00','03:00','06:00','09:00','12:00','15:00','18:00','21:00']);
 const plans=buildVariations([leg('old'),{...leg('live'),live:true},leg('ok')],{now,blocked:new Set(['old'])});assert.equal(plans[0].selections[0].eventId,'ok');assert.ok(!plans[1].reachedTarget);
});
function harness(){const redis=fakeRedis(),booked=[],sent=[];let settled=false;
 const deps={now:()=>now,loadPool:async()=>[leg('1'),leg('2','tennis'),leg('3')],validate:async r=>r,isSettled:async()=>settled,assertBookingReady:async()=>{},book:async rows=>{booked.push(rows);return{shareCode:'CODE'+booked.length}},track:async()=>{},updateTrack:async()=>{},saveCode:async()=>{},send:async text=>sent.push(text)};
 const ctx={redis,slotKey:'2026-10-09T09:00',dateKey:'2026-10-09',slotTime:'09:00'};return{redis,deps,ctx,booked,sent,settle:()=>{settled=true}};
}
test('unsettled games remain excluded at the next slot and across restart until confirmed settled',async()=>{
 const h=harness();assert.equal((await runThreeHourly(h.deps,h.ctx)).ticketsSent,3);
 assert.equal((await runThreeHourly(h.deps,{...h.ctx,slotKey:'2026-10-09T12:00'})).ticketsSent,0);
 assert.equal(h.booked.length,3);h.settle();assert.equal((await runThreeHourly(h.deps,{...h.ctx,slotKey:'2026-10-09T15:00'})).ticketsSent,3);
});
test('uncertain delivery is reserved and never automatically sent again',async()=>{
 const h=harness();h.deps.send=async()=>{throw Error('delivery timeout')};await runThreeHourly(h.deps,h.ctx);assert.equal(h.booked.length,3);await runThreeHourly(h.deps,h.ctx);assert.equal(h.booked.length,3);assert.equal((await h.redis.hVals(RESERVATIONS)).length,3);
});
