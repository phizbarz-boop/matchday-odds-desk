'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {registerTelegramQuickCashRoute,watHourKey,quickCashConfig}=require('../lib/telegramQuickCash');
const {fakeRedis}=require('./fixtures/fake-redis');

function harness(runQuickCash,{redis=fakeRedis()}={}) {
  let handler,clock=new Date('2026-10-06T16:05:00Z');
  registerTelegramQuickCashRoute({post(route,_json,fn){assert.equal(route,'/api/telegram/quick-cash');handler=fn;}},
    {express:{json:()=>()=>{}},authorize:req=>req.headers.secret==='test',getRedis:async()=>redis,runQuickCash,now:()=>clock,logger:{error(){}}});
  const request=({authorized=true,manual=false,runId}={})=>{
    const res=new EventEmitter();Object.assign(res,{destroyed:false,writableEnded:false,statusCode:200});
    res.status=code=>{res.statusCode=code;return res;};res.json=body=>{res.body=body;res.writableEnded=true;res.emit('close');return res;};
    res.disconnect=()=>{res.destroyed=true;res.emit('close');};
    return {res,done:handler({headers:{secret:authorized?'test':'wrong',
      ...(manual?{'x-matchday-run-mode':'manual'}:{}),...(runId?{'x-matchday-run-id':runId}:{})}},res)};
  };
  return {request,redis,setClock:date=>{clock=new Date(date);}};
}
test('hour keys are WAT-correct across midnight and scheduled QC keeps a zero floor',()=>{
  assert.equal(watHourKey(new Date('2026-10-06T23:05:00Z')),'2026-10-07T00');
  assert.deepEqual(quickCashConfig({}),{minProbability:0,liveMode:'quick_cash',intervalMinutes:60,targetOdds:2,maxSelections:15,flexibleTarget:true});
});
test('hourly QC authenticates and requires shared run state before doing work',async()=>{
  let builds=0;const h=harness(async()=>{builds++;});
  const denied=h.request({authorized:false});await denied.done;assert.equal(denied.res.statusCode,401);
  const offline=harness(async()=>{builds++;},{redis:null}).request();await offline.done;
  assert.equal(offline.res.statusCode,503);assert.equal(builds,0);
});
test('QC sends once per hour and a new hour generates a new ticket',async()=>{
  let builds=0;const h=harness(async({onPostingStart})=>{builds++;await onPostingStart();return {sent:true,shareCode:'QC'+builds};});
  const first=h.request();await first.done;assert.equal(first.res.body.sent,true);assert.equal(first.res.body.minProbability,0);
  const repeated=h.request();await repeated.done;assert.equal(repeated.res.body.reason,'already_processed_this_hour');assert.equal(builds,1);
  h.setClock('2026-10-06T17:05:00Z');const next=h.request();await next.done;
  assert.equal(next.res.body.shareCode,'QC2');assert.equal(builds,2);
});
test('no eligible games skips posting for the hour and allows the next hour',async()=>{
  let calls=0;const h=harness(async()=>{calls++;return {sent:false,skipped:true,reason:'no_eligible_live_games'};});
  const first=h.request();await first.done;assert.equal(first.res.body.sent,false);
  assert.equal(JSON.parse(await h.redis.get('telegram:quick-cash:status:2026-10-06T17')).status,'no_eligible_games');
  await h.request().done;assert.equal(calls,1);
  h.setClock('2026-10-06T17:05:00Z');await h.request().done;assert.equal(calls,2);
});
test('failed pre-post QC run releases only its own lock for retry',async()=>{
  let calls=0;const h=harness(async()=>{if(++calls===1)throw Error('SportyBet unavailable');return {sent:false,skipped:true};});
  const failed=h.request();await failed.done;assert.equal(failed.res.statusCode,502);
  assert.equal(await h.redis.exists('telegram:quick-cash:once:2026-10-06T17'),0);
  const retry=h.request();await retry.done;assert.equal(retry.res.statusCode,200);assert.equal(calls,2);
});
test('an ambiguous Telegram QC send retains the hour lock',async()=>{
  let calls=0;const h=harness(async({onPostingStart})=>{calls++;await onPostingStart();throw Error('Telegram timed out');});
  const failed=h.request();await failed.done;assert.equal(failed.res.statusCode,502);
  assert.equal(JSON.parse(await h.redis.get('telegram:quick-cash:status:2026-10-06T17')).status,'partial_or_unknown');
  await h.request().done;assert.equal(calls,1);
});
test('disconnect before posting cancels QC and releases the unfinished hour',async()=>{
  let release,entered;const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  let posts=0;const h=harness(async({shouldAbort,onPostingStart})=>{entered();await gate;if(shouldAbort())throw Error('cancelled');await onPostingStart();posts++;return {sent:true};});
  const pending=h.request();await ready;pending.res.disconnect();release();await pending.done;
  assert.equal(posts,0);assert.equal(await h.redis.exists('telegram:quick-cash:once:2026-10-06T17'),0);
});
test('a partial five-plan result reports failure and permits retries protected by individual ticket locks',async()=>{
  let calls=0;const h=harness(async({onPostingStart})=>{calls++;await onPostingStart();return {sent:true,ticketsSent:1,retryable:calls===1};});
  const first=h.request();await first.done;assert.equal(first.res.statusCode,502);
  assert.equal(await h.redis.exists('telegram:quick-cash:once:2026-10-06T17'),0);
  const retry=h.request();await retry.done;assert.equal(retry.res.statusCode,200);assert.equal(calls,2);
});

test('new manual runs bypass a completed scheduled hour at any minute',async()=>{
  const contexts=[];
  const h=harness(async context=>{contexts.push(context);await context.onPostingStart();return {sent:true,shareCode:'CODE'+contexts.length};});
  h.setClock('2026-10-06T16:47:00Z');
  await h.request().done;
  const a=h.request({manual:true,runId:'github-100-1'});await a.done;
  const b=h.request({manual:true,runId:'github-101-1'});await b.done;
  assert.equal(a.res.body.runMode,'manual');assert.equal(a.res.body.shareCode,'CODE2');assert.equal(b.res.body.shareCode,'CODE3');
  assert.ok(contexts.slice(1).every(c=>c.hourKey==='2026-10-06T17'&&c.runKey!==c.hourKey));
  assert.notEqual(contexts[1].runKey,contexts[2].runKey);
  const scheduled=h.request();await scheduled.done;assert.equal(scheduled.res.body.reason,'already_processed_this_hour');
  assert.equal(contexts.length,3);
});

test('manual runs do not consume the scheduled hour and retry IDs deduplicate across an hour boundary',async()=>{
  let calls=0;const h=harness(async({onPostingStart})=>{calls++;await onPostingStart();return {sent:true};});
  const first=h.request({manual:true,runId:'github-200-1'});await first.done;
  assert.equal(await h.redis.exists('telegram:quick-cash:once:2026-10-06T17'),0);
  await h.request().done;assert.equal(calls,2);
  h.setClock('2026-10-06T17:59:00Z');
  const retry=h.request({manual:true,runId:'github-200-1'});await retry.done;
  assert.equal(retry.res.body.reason,'already_processed_this_manual_run');assert.equal(calls,2);
});

test('manual requests without IDs are fresh intentional runs and still require authorization',async()=>{
  let calls=0;const h=harness(async()=>{calls++;return {sent:false};});
  const denied=h.request({manual:true,authorized:false});await denied.done;assert.equal(denied.res.statusCode,401);
  const a=h.request({manual:true});await a.done;const b=h.request({manual:true});await b.done;
  assert.notEqual(a.res.body.runKey,b.res.body.runKey);assert.equal(calls,2);
  const bad=h.request({manual:true,runId:'unusable:request id'});await bad.done;
  assert.equal(bad.res.statusCode,400);assert.equal(calls,2);
});

test('a failed unsent manual run retries its ID without touching the scheduled lock',async()=>{
  let calls=0;const h=harness(async()=>{if(++calls===1)throw Error('source unavailable');return {sent:false};});
  const a=h.request({manual:true,runId:'github-300-1'});await a.done;assert.equal(a.res.statusCode,502);
  const b=h.request({manual:true,runId:'github-300-1'});await b.done;assert.equal(b.res.statusCode,200);
  assert.equal(calls,2);assert.equal(await h.redis.exists('telegram:quick-cash:once:2026-10-06T17'),0);
});

test('ambiguous manual delivery remains protected for the same workflow request',async()=>{
  let calls=0;const h=harness(async({onPostingStart})=>{calls++;await onPostingStart();throw Error('ambiguous send');});
  const first=h.request({manual:true,runId:'github-400-1'});await first.done;
  const retry=h.request({manual:true,runId:'github-400-1'});await retry.done;
  assert.equal(retry.res.body.reason,'already_processed_this_manual_run');assert.equal(calls,1);
});
