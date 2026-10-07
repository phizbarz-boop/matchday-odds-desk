'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {watParts,createWatScheduler,createWatSlotJob}=require('../lib/watScheduler');
const {fakeRedis}=require('./fixtures/fake-redis');
const timers={setInterval:()=>({unref(){}}),clearInterval(){},setTimeout:()=>({unref(){}}),clearTimeout(){}};
const logger={log(){},error(){}};
const flush=()=>new Promise(r=>setImmediate(r));
test('WAT schedule date changes at 23:00 UTC',()=>{assert.deepEqual(watParts(new Date('2026-10-07T23:00:00Z')),{date:'2026-10-08',minute:0});});
test('public cache runs exactly three WAT slots and Telegram exactly two slots per day',async()=>{
  for(const times of [['06:30','12:30','17:30'],['07:00','18:00']]){
    let clock=new Date('2026-10-07T04:00:00Z');const calls=[];
    const scheduler=createWatScheduler({name:'Test',times,timers,logger,now:()=>clock,runJob:async slot=>{calls.push(slot.slotKey);return {statusCode:200,body:{}};}});
    scheduler.start();await flush();
    for(const time of times){const hour=String(Number(time.slice(0,2))-1).padStart(2,'0');clock=new Date(`2026-10-07T${hour}:${time.slice(3)}:00Z`);await scheduler.tick();await scheduler.tick();}
    assert.deepEqual(calls,times.map(time=>'2026-10-07T'+time));scheduler.stop();
  }
});
test('restart uses only the latest due slot within the catchup window',async()=>{
  const calls=[];let clock=new Date('2026-10-07T17:30:00Z');
  const scheduler=createWatScheduler({name:'Test',times:['07:00','18:00'],catchupMinutes:60,timers,logger,now:()=>clock,runJob:async slot=>{calls.push(slot.slotTime);return {statusCode:200,body:{}};}});
  scheduler.start();await flush();assert.deepEqual(calls,['18:00']);scheduler.stop();
  clock=new Date('2026-10-08T07:01:00Z');const tooLate=createWatScheduler({name:'Test',times:['07:00','18:00'],catchupMinutes:60,timers,logger,now:()=>clock,runJob:async()=>{throw new Error('must not replay');}});
  tooLate.start();await flush();assert.equal(tooLate.status().lastRun,null);tooLate.stop();
});
test('slot retry waits two minutes and stopping the server aborts active work',async()=>{
  let clock=new Date('2026-10-07T06:00:00Z'),calls=0;
  const scheduler=createWatScheduler({name:'Test',times:['07:00'],timers,logger,now:()=>clock,runJob:async()=>({statusCode:++calls===1?502:200,body:{retryable:calls===1}})});
  scheduler.start();await flush();await scheduler.tick();assert.equal(calls,1);
  clock=new Date(clock.getTime()+120000);await scheduler.tick();assert.equal(calls,2);scheduler.stop();
  let signal,finish;const active=createWatScheduler({name:'Test',times:['07:00'],timers,logger,now:()=>clock,runJob:slot=>{signal=slot.signal;return new Promise(resolve=>{finish=resolve;});}});
  active.start();await flush();active.stop();assert.equal(signal.aborted,true);finish({statusCode:200,body:{}});await flush();
});
test('Redis protects slots across processes but a failed run releases its running lease',async()=>{
  const redis=fakeRedis(),context={slotKey:'2026-10-07T07:00',dateKey:'2026-10-07',slotTime:'07:00'};let calls=0,fail=true;
  const job=createWatSlotJob({namespace:'test',getRedis:async()=>redis,timers,run:async()=>{calls++;if(fail)throw new Error('temporary');return {ticketsSent:6};}});
  assert.equal((await job(context)).statusCode,502);fail=false;assert.equal((await job(context)).body.ticketsSent,6);
  const restarted=createWatSlotJob({namespace:'test',getRedis:async()=>redis,timers,run:async()=>{throw new Error('duplicate');}});
  assert.equal((await restarted(context)).body.reason,'already_processed_this_slot');assert.equal(calls,2);
  const next={...context,slotKey:'2026-10-07T18:00'};await redis.set('test:once:'+next.slotKey,'another-worker');
  assert.equal((await job(next)).body.reason,'slot_in_progress');assert.equal((await job(next)).body.retryable,true);
});
test('a busy public-refresh slot logs its lock outcome without copying an upstream error',async()=>{
  const messages=[];
  const scheduler=createWatScheduler({name:'SportyBet public refresh',times:['06:30'],timers,now:()=>new Date('2026-10-07T08:13:00Z'),
    logger:{log:line=>messages.push(line),error(){}},runJob:async()=>({statusCode:503,body:{retryable:true,reason:'slot_in_progress',error:'fixture-private-upstream-message'}})});
  scheduler.start();await flush();
  assert.ok(messages.some(line=>line.includes('outcome=slot_in_progress')));
  assert.equal(messages.some(line=>line.includes('fixture-private-upstream-message')),false);scheduler.stop();
});
