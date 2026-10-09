'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fork}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
async function server(t,mode) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'telegram-safe-api-'));
  const child=fork(path.join(__dirname,'fixtures/telegram-picks-api-server.js'),[],{cwd:path.join(__dirname,'..'),silent:true,
    env:{...process.env,PORT:'0',NODE_ENV:'production',REDIS_URL:'redis://fixture-only',SPORTYBET_PUBLIC_CACHE_ENABLED:'false',TELEGRAM_NEXT12H_ENABLED:'false',
      TELEGRAM_BOT_TOKEN:mode==='missing-config'?'':'fixture-bot-token',TELEGRAM_CHAT_ID:'fixture-chat',TELEGRAM_JOB_SECRET:'fixture-job-secret',
      SPORTYBET_PHONE:'2348000000000',SPORTYBET_PASSWORD:'fixture-password',SPORTYBET_SESSION_FILE:path.join(directory,'session.json'),SPORTYBET_BOOTSTRAP_COOKIES:'',SPORTYBET_PROXY_URL:'',
      SPORTYBET_STATS_FILE:path.join(directory,'stats.json'),TELEGRAM_PICKS_TEST_MODE:mode,SPORTYBET_MAX_PAGES:'1'}});
  let logs='';child.stdout.on('data',data=>{logs+=data;});child.stderr.on('data',data=>{logs+=data;});
  t.after(()=>{child.kill();fs.rmSync(directory,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);child.once('message',message=>{clearTimeout(timer);resolve(message.port);});child.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code+': '+logs));});});
  let sequence=0;const pending=new Map();child.on('message',message=>{pending.get(message.id)?.(message.data);pending.delete(message.id);});
  const rpc=action=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);child.send({id,action});});
  const headers={'x-telegram-job-secret':'fixture-job-secret',Prefer:'respond-async','x-matchday-run-mode':'manual','x-matchday-run-id':'gh-api-123',Connection:'close'};
  const post=async(extra={})=>{const response=await fetch(`http://127.0.0.1:${port}/api/telegram/daily-picks`,{method:'POST',headers:{...headers,'Content-Type':'application/json',...extra},body:'{}'});return {status:response.status,body:await response.json()};};
  const get=async(url='/api/telegram/daily-picks/run-status/gh-api-123',auth=true)=>{const response=await fetch(`http://127.0.0.1:${port}${url}`,{headers:auth?{'x-telegram-job-secret':'fixture-job-secret'}:{}});return {status:response.status,body:await response.json()};};
  const finish=async()=>{for(let i=0;i<300;i++){const result=await get();if(result.status!==202)return result;await new Promise(r=>setTimeout(r,10));}assert.fail(logs);};
  return {post,get,finish,rpc,logs:()=>logs};
}

test('real Telegram SAFE HTTP jobs return promptly, survive disconnect and generate one anonymous ticket',async t=>{
  const api=await server(t,'delayed'),first=await api.post();assert.equal(first.status,202,JSON.stringify(first.body));
  assert.equal((await api.get(undefined,false)).status,401);
  for(let i=0;i<100&&(await api.rpc('state')).reads.length===0;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal((await api.get()).body.stage,'scanning_sportybet');assert.equal((await api.post()).status,202);
  assert.equal((await api.rpc('state')).messages.length,0);await api.rpc('release');
  const done=await api.finish();assert.equal(done.status,200,JSON.stringify(done.body)+'\n'+api.logs());
  assert.equal(done.body.ticketsSent,1);assert.equal(done.body.results[0].shareCode,'SAFE-API-1');
  assert.equal(done.body.plans[0].minProbability,85);assert.ok(done.body.results[0].combinedOdds>=1.30&&done.body.results[0].combinedOdds<=5);
  const state=await api.rpc('state');assert.equal(state.bookings.length,1);assert.ok(state.bookings[0].length<=15);assert.equal(state.messages.length,2);
  assert.match(state.messages.at(-1),/SAFE-API-1/);assert.equal((await api.post()).body.ticketsSent,1);assert.equal((await api.rpc('state')).bookings.length,1);
  assert.doesNotMatch(JSON.stringify(done.body),/fixture-job-secret|fixture-bot-token|fixture-password/);
});

test('real empty public slate completes with no ticket and preserves previous Today’s Codes',async t=>{
  const api=await server(t,'empty');assert.equal((await api.post()).status,202);const done=await api.finish();
  assert.equal(done.status,200,JSON.stringify(done.body));assert.equal(done.body.ticketsSent,0);assert.equal(done.body.reason,'no_eligible_safe_games');
  const state=await api.rpc('state');assert.equal(state.bookings.length,0);assert.equal(state.storedCodes.codes[0].shareCode,'PREVIOUS-SAFE');
  assert.match(state.messages.at(-1),/NOT GENERATED/);
});

test('real upstream failures report SportyBet source diagnostics without Telegram sending',async t=>{
  const api=await server(t,'source-failure');assert.equal((await api.post()).status,202);const done=await api.finish();
  assert.equal(done.status,502);assert.equal(done.body.code,'SPORTYBET_SOURCE_UNAVAILABLE');assert.ok(Object.keys(done.body.diagnostics.sourceErrors).length>0);
  assert.equal((await api.rpc('state')).messageAttempts,0);assert.equal((await api.post()).body.runRequestStatus,'failed');
});

test('missing app bot settings fail before any public SportyBet scan',async t=>{
  const api=await server(t,'missing-config');const response=await api.post();assert.equal(response.status,503);
  assert.deepEqual(response.body.missingSettings,['TELEGRAM_BOT_TOKEN']);assert.equal((await api.rpc('state')).reads.length,0);
});

test('real booking rejection fails the run and preserves the previous code',async t=>{
  const api=await server(t,'booking-failure');await api.post();const done=await api.finish();
  assert.equal(done.status,502);assert.match(done.body.detail,/suspended/);assert.equal(done.body.stage,'booking_code');
  const state=await api.rpc('state');assert.equal(state.bookings.length,1);assert.equal(state.messages.length,1);assert.equal(state.storedCodes.codes[0].shareCode,'PREVIOUS-SAFE');
});

test('real Telegram delivery rejection keeps the generated code and reports the delivery error',async t=>{
  const api=await server(t,'send-failure');await api.post();const done=await api.finish();
  assert.equal(done.status,502);assert.match(done.body.detail,/bot was blocked/);assert.equal(done.body.stage,'sending_ticket');
  const state=await api.rpc('state');assert.equal(state.bookings.length,1);assert.equal(state.messageAttempts,2);assert.ok(state.storedCodes.codes.some(c=>c.shareCode==='SAFE-API-1'));
  assert.equal((await api.post()).status,502);assert.equal((await api.rpc('state')).messageAttempts,2);
});
