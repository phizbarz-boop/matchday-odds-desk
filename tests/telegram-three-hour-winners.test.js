'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {TIMES,PLANS,resolveSlot}=require('../lib/telegramThreeHourWinners');
const {buildPack}=require('../lib/telegramFloorPicks');
test('6-hour winners use WAT kickoff dates and rank distinct eligible matches by price',()=>{
 const now=new Date('2026-11-11T11:00:00Z');
 assert.equal(TIMES.length,4);
 assert.equal(resolveSlot({},now).slotTime,'12:00');
 const row={sport:'tennis',marketId:'1',outcomeId:'1',betType:'tennis_winner',probability:70,kickoffUtc:'2026-11-12T22:59:00Z'};
 const rows=Array.from({length:12},(_,i)=>({...row,eventId:String(i),odds:1.2+i/10}));
 rows.push({...row,eventId:'tooLate',kickoffUtc:'2026-11-12T23:00:00Z',odds:20},{...row,eventId:'tooLow',probability:69,odds:20},{...row,eventId:'wrongMarket',betType:'tennis_over',odds:20});
 const [plan]=buildPack(rows,{now,plans:PLANS}).plans;
 assert.deepEqual(plan.selections.map(c=>c.eventId),['11','10']);
});

test('individual sport tickets include tennis and stop at the seventh WAT date',()=>{
 const {PLANS:daily,eligible}=require('../lib/telegramFloorPicks');
 const now=new Date('2026-11-11T11:00:00Z');
 for(const sport of ['basketball','hockey','handball','tennis']){
  const plan=daily.find(p=>p.id===sport+'Winners70');
  assert.equal(plan.kickoffWindowDays,7);
  const row={eventId:'1',sport,marketId:'1',outcomeId:'1',betType:sport+'_winner',probability:70,odds:1.5,kickoffUtc:'2026-11-17T22:59:00Z'};
  assert.equal(eligible(row,plan,now,'2026-11-11',new Set()),true);
  assert.equal(eligible({...row,kickoffUtc:'2026-11-17T23:00:00Z'},plan,now,'2026-11-11',new Set()),false);
 }
});
