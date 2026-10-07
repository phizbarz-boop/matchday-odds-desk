'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTelegramRunRequests}=require('../lib/telegramRunRequests');
const {fakeRedis}=require('./fixtures/fake-redis');
const env={TELEGRAM_BOT_TOKEN:'fixture-bot-token',TELEGRAM_CHAT_ID:'fixture-chat'};
const authorize=req=>req.headers['x-telegram-job-secret']==='fixture-job-secret';
const logger={log(){},warn(){},error(){}};
const request=(id='gh-123',extra={})=>({headers:{'x-telegram-job-secret':'fixture-job-secret',prefer:'respond-async',
  'x-matchday-run-mode':'manual','x-matchday-run-id':id},body:{},...extra});
function response(){return {statusCode:200,status(code){this.statusCode=code;return this;},set(){return this;},json(body){this.body=body;return this;}};}
function gate(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const tick=()=>new Promise(r=>setImmediate(r));
function manager(redis,extra={}){return createTelegramRunRequests({name:'daily-picks',authorize,getRedis:async()=>redis,env,logger,...extra});}
async function post(handler,req=request()){const res=response();await handler(req,res);return res;}
async function status(api,id='gh-123',headers=request().headers){const res=response();await api.status({params:{runId:id},headers},res);return res;}
async function finish(api,id='gh-123'){for(let i=0;i<100;i++){const result=await status(api,id);if(result.statusCode!==202)return result;await tick();}assert.fail('Run did not finish');}

test('accepted jobs survive the submission connection and retries only retrieve one result',async()=>{
  const redis=fakeRedis(),api=manager(redis),entered=gate(),release=gate();let calls=0;
  const handler=api.wrap(async(_req,res)=>{calls++;await res.jobStage('scanning_sportybet');entered.resolve();await release.promise;res.json({ok:true,ticketsSent:1,results:[{shareCode:'SAFE-ONE'}]});});
  const first=await post(handler);assert.equal(first.statusCode,202);await entered.promise;
  assert.equal((await post(handler)).statusCode,202);assert.equal(calls,1);
  const pending=await status(api);assert.equal(pending.body.stage,'scanning_sportybet');
  release.resolve();const done=await finish(api);assert.equal(done.statusCode,200);assert.equal(done.body.results[0].shareCode,'SAFE-ONE');
  assert.equal((await post(handler)).body.runRequestStatus,'completed');assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify([...redis.data]),/fixture-job-secret|fixture-bot-token/);
});

test('another instance reads the running and completed job without sending it again',async()=>{
  const redis=fakeRedis(),first=manager(redis),second=manager(redis),release=gate();let calls=0;
  const work=async(_req,res)=>{calls++;await release.promise;res.json({ok:true,ticketsSent:1});};
  await post(first.wrap(work));await tick();const duplicate=await post(second.wrap(work));
  assert.equal(duplicate.statusCode,202);assert.equal(calls,1);
  release.resolve();await finish(first);const restored=await status(second);assert.equal(restored.statusCode,200);assert.equal(restored.body.ticketsSent,1);
});

test('reusing an ID with different payload or run mode is rejected',async()=>{
  const api=manager(fakeRedis()),handler=api.wrap(async(_req,res)=>res.json({ok:true}));
  await post(handler);await finish(api);
  const changed=await post(handler,request('gh-123',{body:{different:true}}));assert.equal(changed.statusCode,409);assert.equal(changed.body.code,'TELEGRAM_RUN_CONFLICT');
  const req=request();req.headers['x-matchday-run-mode']='scheduled';assert.equal((await post(handler,req)).statusCode,409);
});

test('a stopped process leaves an unknown job that cannot be automatically restarted',async()=>{
  const redis=fakeRedis(),api=manager(redis,{now:()=>100}),release=gate();let calls=0;
  await post(api.wrap(async(_req,res)=>{calls++;await release.promise;res.json({ok:true});}));await tick();
  const restarted=manager(redis,{now:()=>2200000});const result=await post(restarted.wrap(async()=>{calls++;}));
  assert.equal(result.statusCode,409);assert.equal(result.body.runRequestStatus,'unknown');assert.equal(calls,1);
  release.resolve();await finish(api);
});

test('source and delivery failures keep their original HTTP details and cannot rerun the same ID',async()=>{
  const api=manager(fakeRedis());let calls=0;
  const handler=api.wrap(async(_req,res)=>{calls++;res.status(502).json({error:'Telegram picks job failed',code:'SPORTYBET_SOURCE_UNAVAILABLE',detail:'Failed basketball feed'});});
  await post(handler);const done=await finish(api);assert.equal(done.statusCode,502);assert.equal(done.body.detail,'Failed basketball feed');
  assert.equal(done.body.runRequestStatus,'failed');assert.equal((await post(handler)).statusCode,502);assert.equal(calls,1);
});

test('authorization protects submission and status before accessing Redis',async()=>{
  let storage=0,work=0;const api=manager(null,{getRedis:async()=>{storage++;}});
  const result=await post(api.wrap(async()=>{work++;}),request('gh-123',{headers:{}}));assert.equal(result.statusCode,401);
  assert.equal((await status(api,'gh-123',{})).statusCode,401);assert.equal(storage,0);assert.equal(work,0);
});

test('missing app Telegram settings and Redis are reported before market scanning',async()=>{
  let work=0;const missing=manager(fakeRedis(),{env:{}});
  const result=await post(missing.wrap(async()=>{work++;}));assert.equal(result.statusCode,503);
  assert.deepEqual(result.body.missingSettings,['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID']);
  const noRedis=await post(manager(null).wrap(async()=>{work++;}));assert.equal(noRedis.body.code,'TELEGRAM_REDIS_REQUIRED');assert.equal(work,0);
});

test('an ambiguous Redis claim failure does not launch or restart a worker',async()=>{
  const redis=fakeRedis(),set=redis.set.bind(redis);let work=0,fail=true;
  redis.set=async(...args)=>{const result=await set(...args);if(fail){fail=false;throw Error('Lost storage response');}return result;};
  const api=manager(redis),handler=api.wrap(async()=>{work++;});const first=await post(handler);
  assert.equal(first.statusCode,503);assert.equal((await post(handler)).statusCode,202);assert.equal(work,0);
});

test('status lookup never starts a missing job',async()=>{
  const api=manager(fakeRedis());const result=await status(api,'missing');assert.equal(result.statusCode,404);assert.equal(result.body.code,'TELEGRAM_RUN_NOT_FOUND');
});
