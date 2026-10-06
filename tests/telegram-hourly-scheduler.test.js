'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTelegramHourlyScheduler,hourlySchedulerConfig}=require('../lib/telegramHourlyScheduler');
const {createTelegramQuickCashJob}=require('../lib/telegramQuickCash');
const {fakeRedis}=require('./fixtures/fake-redis');

const configured={REDIS_URL:'redis://test-only',TELEGRAM_BOT_TOKEN:'test-only',TELEGRAM_CHAT_ID:'test-only'};
const completed=()=>({statusCode:200,body:{sent:true,ticketsSent:5,results:[{id:'qc_football',sent:true}]}});
const flush=()=>new Promise(setImmediate);
function harness({env={},runJob=async()=>completed(),date='2026-10-06T16:04:00Z'}={}) {
  let clock=new Date(date),interval,deadline;
  const calls=[],logs=[];
  const timers={setInterval(fn,ms){assert.equal(ms,30000);interval=fn;return {unref(){}};},
    clearInterval(){interval=null;},setTimeout(fn,ms){assert.equal(ms,780000);deadline=fn;return {unref(){}};},
    clearTimeout(){deadline=null;}};
  const now=()=>clock;
  const scheduler=createTelegramHourlyScheduler({env:{...configured,...env},now,timers,
    logger:{log:line=>logs.push(line),error:(...parts)=>logs.push(parts.join(' '))},
    runJob:async context=>{calls.push(context);return runJob(context);}});
  return {scheduler,calls,logs,now,setClock:value=>{clock=new Date(value);},
    poll:()=>interval?.(),expire:()=>deadline?.()};
}
function protectedHarness(runQuickCash,options={}) {
  const redis=options.redis||fakeRedis();
  let job;
  const h=harness({...options,runJob:context=>job(context)});
  job=createTelegramQuickCashJob({getRedis:async()=>redis,runQuickCash,now:h.now,logger:{error(){}}});
  return {...h,redis,job};
}

test('direct scheduling needs Redis and Telegram but no GitHub or job-secret configuration',()=>{
  assert.equal(hourlySchedulerConfig(configured).configured,true);
  assert.equal(hourlySchedulerConfig(configured).minute,5);
  assert.equal(hourlySchedulerConfig({...configured,TELEGRAM_HOURLY_MINUTE:'0'}).minute,0);
  assert.equal(hourlySchedulerConfig({...configured,TELEGRAM_HOURLY_MINUTE:'60'}).minute,5);
  assert.equal(hourlySchedulerConfig({...configured,TELEGRAM_HOURLY_ENABLED:'false'}).enabled,false);
  assert.deepEqual(hourlySchedulerConfig({}).missing,['REDIS_URL','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID']);
});

test('server clock runs at :05 once each WAT hour without an HTTP request',async()=>{
  const h=harness();h.scheduler.start();await flush();
  assert.equal(h.calls.length,0);assert.equal(h.scheduler.status().nextRunAt,'2026-10-06T16:05:00.000Z');
  h.setClock('2026-10-06T16:05:00Z');await h.scheduler.tick();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].runMode,'scheduled');
  assert.equal(h.scheduler.status().lastRun.hourKey,'2026-10-06T17');
  assert.equal(h.scheduler.status().lastRun.ticketsSent,5);
  await h.scheduler.tick();h.setClock('2026-10-06T16:59:00Z');await h.scheduler.tick();assert.equal(h.calls.length,1);
  h.setClock('2026-10-06T17:05:00Z');h.poll();await flush();assert.equal(h.calls.length,2);
  assert.equal(h.scheduler.status().nextRunAt,'2026-10-06T18:05:00.000Z');h.scheduler.stop();
});

test('a late startup catches up the current hour and never replays historical live hours',async()=>{
  const h=harness({date:'2026-10-06T23:49:00Z'});h.scheduler.start();await flush();
  assert.equal(h.calls.length,1);assert.equal(h.scheduler.status().lastRun.hourKey,'2026-10-07T00');
  h.setClock('2026-10-07T02:06:00Z');await h.scheduler.tick();
  assert.equal(h.calls.length,2);assert.equal(h.scheduler.status().lastRun.hourKey,'2026-10-07T03');h.scheduler.stop();
});

test('starting twice cannot register a second hourly run; a disabled or incomplete server never starts',async()=>{
  for(const env of [{TELEGRAM_HOURLY_ENABLED:'false'},{TELEGRAM_BOT_TOKEN:''},{REDIS_URL:''}]) {
    const h=harness({env,date:'2026-10-06T16:25:00Z'});h.scheduler.start();await flush();
    assert.equal(h.calls.length,0);assert.equal(h.scheduler.status().running,false);assert.equal(h.scheduler.status().nextRunAt,null);
  }
  const h=harness({date:'2026-10-06T16:25:00Z'});h.scheduler.start();h.scheduler.start();await flush();
  assert.equal(h.calls.length,1);h.scheduler.stop();
});

test('source failures retry after two minutes and a healthy batch stops retrying for the hour',async()=>{
  const h=harness({runJob:async()=>h.calls.length===1?{statusCode:502,body:{error:'source unavailable'}}:completed()});
  h.scheduler.start();h.setClock('2026-10-06T16:05:00Z');await h.scheduler.tick();
  assert.equal(h.scheduler.status().lastRun.status,'retry_pending');
  assert.equal(h.scheduler.status().nextRunAt,'2026-10-06T16:07:00.000Z');
  h.setClock('2026-10-06T16:06:59Z');await h.scheduler.tick();assert.equal(h.calls.length,1);
  h.setClock('2026-10-06T16:07:00Z');await h.scheduler.tick();assert.equal(h.calls.length,2);
  await h.scheduler.tick();assert.equal(h.calls.length,2);h.scheduler.stop();
});

test('a partially sent five-category batch schedules a retry and preserves category outcomes in status',async()=>{
  const h=harness({runJob:async()=>h.calls.length===1?{statusCode:502,body:{sent:true,ticketsSent:4,retryable:true,
    results:[{id:'qc_football',sent:true},{id:'qc_basketball',sent:false,error:'Booking unavailable'}]}}:completed()});
  h.scheduler.start();h.setClock('2026-10-06T16:05:00Z');await h.scheduler.tick();
  const status=h.scheduler.status();assert.equal(status.lastRun.ticketsSent,4);assert.equal(status.lastRun.plans[1].failed,true);
  assert.equal(JSON.stringify(status).includes('Booking unavailable'),false);
  h.setClock('2026-10-06T16:07:00Z');await h.scheduler.tick();assert.equal(h.calls.length,2);h.scheduler.stop();
});

test('two server instances and a restart share the same Redis hourly lock',async()=>{
  const redis=fakeRedis();let builds=0;
  const runQuickCash=async({onPostingStart})=>{builds++;await onPostingStart();return {sent:true,ticketsSent:5};};
  const a=protectedHarness(runQuickCash,{redis}),b=protectedHarness(runQuickCash,{redis});
  a.scheduler.start();b.scheduler.start();a.setClock('2026-10-06T16:05:00Z');b.setClock('2026-10-06T16:05:00Z');
  await Promise.all([a.scheduler.tick(),b.scheduler.tick()]);assert.equal(builds,1);
  a.scheduler.stop();b.scheduler.stop();
  const restarted=protectedHarness(runQuickCash,{redis,date:'2026-10-06T16:49:00Z'});
  restarted.scheduler.start();await flush();assert.equal(builds,1);
  assert.equal(restarted.scheduler.status().lastRun.reason,'already_processed_this_hour');
  restarted.setClock('2026-10-06T17:05:00Z');await restarted.scheduler.tick();assert.equal(builds,2);restarted.scheduler.stop();
});

test('a busy server avoids overlapping builds and stops the old hour before later posting',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const h=harness({runJob:async context=>{await gate;return context.shouldAbort()?{statusCode:499,body:{}}:completed();}});
  h.scheduler.start();h.setClock('2026-10-06T16:05:00Z');const pending=h.scheduler.tick();await flush();
  assert.equal(h.scheduler.status().busy,true);assert.equal(await h.scheduler.tick(),false);assert.equal(h.calls.length,1);
  h.setClock('2026-10-06T17:05:00Z');assert.equal(h.calls[0].shouldAbort(),true);
  release();await pending;h.scheduler.stop();
});

test('shutdown aborts an unsent direct run and releases its owned Redis lock',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});let posts=0;
  const h=protectedHarness(async({onPostingStart})=>{await gate;await onPostingStart();posts++;return {sent:true};});
  h.scheduler.start();h.setClock('2026-10-06T16:05:00Z');const pending=h.scheduler.tick();await flush();
  assert.equal(await h.redis.exists('telegram:quick-cash:once:2026-10-06T17'),1);
  h.scheduler.stop();await pending;await flush();
  assert.equal(await h.redis.exists('telegram:quick-cash:once:2026-10-06T17'),0);
  release();await flush();assert.equal(posts,0);assert.equal(h.scheduler.status().running,false);
});

test('an exceeded run deadline aborts the direct job and leaves the timer able to retry',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});let posts=0;
  const h=protectedHarness(async({onPostingStart})=>{await gate;await onPostingStart();posts++;return {sent:true};});
  h.scheduler.start();h.setClock('2026-10-06T16:05:00Z');const pending=h.scheduler.tick();await flush();
  h.setClock('2026-10-06T16:18:00Z');h.expire();await pending;
  assert.equal(h.scheduler.status().busy,false);assert.equal(h.calls[0].signal.aborted,true);
  assert.equal(h.scheduler.status().nextRunAt,'2026-10-06T16:20:00.000Z');
  release();await flush();assert.equal(posts,0);h.scheduler.stop();
});

test('no eligible live games completes the hour and the next hour reads again',async()=>{
  let builds=0;const h=protectedHarness(async()=>{builds++;return {sent:false,skipped:true,reason:'no_eligible_live_games'};});
  h.scheduler.start();h.setClock('2026-10-06T16:05:00Z');await h.scheduler.tick();await h.scheduler.tick();
  assert.equal(builds,1);assert.equal(h.scheduler.status().lastRun.reason,'no_eligible_live_games');
  h.setClock('2026-10-06T17:05:00Z');await h.scheduler.tick();assert.equal(builds,2);h.scheduler.stop();
});

test('an unexpected runner rejection is caught and retries without killing the hourly clock',async()=>{
  const h=harness({runJob:async()=>{throw Error('test failure');}});h.scheduler.start();
  h.setClock('2026-10-06T16:05:00Z');await h.scheduler.tick();
  assert.equal(h.scheduler.status().busy,false);assert.equal(h.scheduler.status().lastRun.status,'retry_pending');
  assert.ok(h.logs.some(line=>line.includes('test failure')));h.scheduler.stop();
});
