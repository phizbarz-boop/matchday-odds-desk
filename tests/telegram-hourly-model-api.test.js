'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fork,spawn}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
async function server(t,{enabled='true'}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'telegram-hourly-model-'));
  const child=fork(path.join(__dirname,'fixtures/hourly-model-api-server.js'),[],{cwd:path.join(__dirname,'..'),silent:true,
    env:{...process.env,PORT:'0',REDIS_URL:'redis://fixture-only',TELEGRAM_BOT_TOKEN:'fixture-only',TELEGRAM_CHAT_ID:'fixture-only',TELEGRAM_JOB_SECRET:'fixture-secret',
      TELEGRAM_WEBHOOK_SECRET:'fixture-hook',TELEGRAM_HOURLY_MODEL_ENABLED:enabled,TELEGRAM_HOURLY_ENABLED:'false',
      SPORTYBET_SESSION_FILE:path.join(directory,'session.json'),SPORTYBET_PUBLIC_CACHE_FILE:path.join(directory,'catalog.json'),SPORTYBET_STATS_FILE:path.join(directory,'stats.json'),
      SPORTYBET_PHONE:'2348000000000',SPORTYBET_PASSWORD:'fixture-password',SPORTYBET_BOOTSTRAP_COOKIES:'',SPORTYBET_PROXY_URL:'',SPORTYBET_LIVE_MAX_PAGES:'1',GITHUB_ACTIONS:''}});
  let logs='';child.stdout.on('data',d=>{logs+=d;});child.stderr.on('data',d=>{logs+=d;});t.after(()=>{child.kill();fs.rmSync(directory,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);child.once('message',m=>{clearTimeout(timer);resolve(m.port);});child.once('exit',code=>{clearTimeout(timer);reject(Error('Exit '+code+': '+logs));});});
  const base=`http://127.0.0.1:${port}`;let sequence=0;const pending=new Map();child.on('message',m=>{pending.get(m.id)?.(m.data);pending.delete(m.id);});
  const rpc=(action,change={})=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);child.send({id,action,...change});});
  const request=async(route,body,headers={})=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
  const finish=async predicate=>{for(let i=0;i<400;i++){const r=await request('/api/telegram/status');if(predicate(r.body))return r.body;await new Promise(r=>setTimeout(r,10));}assert.fail(logs);};
  const workflow=()=>new Promise((resolve,reject)=>{
    const runner=spawn('python3',['jobs/telegram-picks-runner.py','--endpoint','hourly-picks'],{cwd:path.join(__dirname,'..'),env:{...process.env,
      MATCHDAY_BASE_URL:base,TELEGRAM_JOB_SECRET:'fixture-secret',GITHUB_RUN_ID:'fixture-hourly-123',GH_EVENT_NAME:'workflow_dispatch',
      TELEGRAM_POLL_SECONDS:'.01',TELEGRAM_POLL_MAX_SECONDS:'10',TELEGRAM_REQUEST_TIMEOUT_SECONDS:'2'}});
    let output='';runner.stdout.on('data',d=>{output+=d;});runner.stderr.on('data',d=>{output+=d;});runner.once('error',reject);runner.once('exit',code=>resolve({code,output}));
  });
  return {rpc,request,finish,workflow,directory,logs:()=>logs};
}
test('app-server scans hourly and sends Live 3, QC 3 and Live 1000 through public SportyBet without GitHub',async t=>{
  const api=await server(t);assert.equal((await api.rpc('state')).bookings.length,0);
  const initial=(await api.request('/api/telegram/status')).body;assert.equal(initial.hourlyScheduler.running,true);assert.equal(initial.hourlyScheduler.minute,5);
  assert.deepEqual(initial.rules.hourly.plans.map(p=>p.targetOdds),[3,3,1000]);assert.equal(initial.rules.hourly.cacheRequired,false);
  assert.deepEqual(initial.rules.hourly.plans.map(p=>p.minProbability),[85,80,85]);
  await api.rpc('clock',{date:'2026-10-08T11:05:00Z'});
  let status=await api.finish(s=>s.hourlyScheduler.lastRun?.status==='completed');assert.equal(status.hourlyScheduler.lastRun.ticketsSent,3,api.logs());
  let state=await api.rpc('state');assert.equal(state.bookings.length,3);assert.equal(state.sessionChecks,0);
  assert.ok(state.messages.some(m=>m.includes('HOURLY LIVE · 3 ODDS')));assert.ok(state.messages.some(m=>m.includes('HOURLY QC · 3 ODDS')));assert.ok(state.messages.some(m=>m.includes('HOURLY LIVE · 1,000 ODDS')));
  assert.match(state.messages.find(m=>m.includes('HOURLY QC · 3 ODDS')),/80%/);
  assert.ok(state.bookings.every(s=>s.length<=40));assert.ok(state.reads.every(url=>!url.includes('/patron/')&&!url.includes('pcUpcomingEvents')));
  const codes=state.hashes.find(([key])=>key==='telegram:quick-cash:codes:2026-10-08')[1].map(([,raw])=>JSON.parse(raw));assert.equal(codes.length,3);
  const tracked=state.hashes.find(([key])=>key==='telegram:tracked-tickets:v2')[1].map(([,raw])=>JSON.parse(raw));assert.equal(tracked.length,3);assert.ok(tracked.every(t=>t.delivery==='posted'));
  assert.deepEqual(codes.map(c=>c.planId).sort(),['live_1000','live_3','qc_3']);assert.ok(codes.every(c=>c.combinedOdds>=(c.planId==='live_1000'?1000:3)));
  await api.rpc('clock',{date:'2026-10-08T11:30:00Z'});assert.equal((await api.rpc('state')).bookings.length,3);
  await api.rpc('clock',{date:'2026-10-08T12:05:00Z'});status=await api.finish(s=>s.hourlyScheduler.lastRun?.hourKey==='2026-10-08T13'&&s.hourlyScheduler.lastRun.status==='completed');
  assert.equal(status.hourlyScheduler.lastRun.ticketsSent,3);state=await api.rpc('state');assert.equal(state.bookings.length,6);
  assert.ok(!fs.existsSync(path.join(api.directory,'catalog.json')));assert.equal(state.sessionChecks,0);
});
test('a confirmed hourly booking rejection retries only the unsent ticket after two minutes',async t=>{
  const api=await server(t);await api.rpc('configure',{failBooking:true});await api.rpc('clock',{date:'2026-10-08T11:05:00Z'});
  let status=await api.finish(s=>s.hourlyScheduler.lastRun?.status==='retry_pending');assert.equal(status.hourlyScheduler.lastRun.ticketsSent,2);
  assert.equal((await api.rpc('state')).bookings.length,2);
  await api.rpc('clock',{date:'2026-10-08T11:07:00Z'});status=await api.finish(s=>s.hourlyScheduler.lastRun?.status==='completed');
  assert.equal(status.hourlyScheduler.lastRun.ticketsSent,1);assert.equal((await api.rpc('state')).bookings.length,3);
});
test('empty live boards send one hourly explanation and can discover games in the next hour',async t=>{
  const api=await server(t);await api.rpc('configure',{empty:true});await api.rpc('clock',{date:'2026-10-08T11:05:00Z'});
  const status=await api.finish(s=>s.hourlyScheduler.lastRun?.status==='completed');assert.equal(status.hourlyScheduler.lastRun.ticketsSent,0);
  let state=await api.rpc('state');assert.equal(state.bookings.length,0);assert.equal(state.messages.length,1);assert.match(state.messages[0],/HOURLY CHECK/);
  await api.rpc('clock',{date:'2026-10-08T11:10:00Z'});assert.equal((await api.rpc('state')).messages.length,1);
  await api.rpc('configure',{empty:false});await api.rpc('clock',{date:'2026-10-08T12:05:00Z'});
  await api.finish(s=>s.hourlyScheduler.lastRun?.hourKey==='2026-10-08T13'&&s.hourlyScheduler.lastRun.status==='completed');
  state=await api.rpc('state');assert.equal(state.bookings.length,3);
});
test('manual hourly workflow uses recoverable HTTP jobs and a repeated run ID cannot book or send twice',async t=>{
  const api=await server(t,{enabled:'false'});
  assert.equal((await api.request('/api/telegram/hourly-picks',{})).status,401);
  const result=await api.workflow();assert.equal(result.code,0,result.output+'\n'+api.logs());assert.match(result.output,/"ticketsSent": 3/);
  const state=await api.rpc('state');assert.equal(state.bookings.length,3);assert.equal(state.sessionChecks,0);
  assert.match(state.messages.find(m=>m.includes('HOURLY QC · 3 ODDS')),/80%/);
  assert.equal((await api.request('/api/telegram/hourly-picks/run-status/fixture-hourly-123')).status,401);
  assert.equal((await api.workflow()).code,0);assert.equal((await api.rpc('state')).bookings.length,3);
});
test('failed public live reads remain source errors and later recover without dummy login',async t=>{
  const api=await server(t);await api.rpc('configure',{failReads:true});await api.rpc('clock',{date:'2026-10-08T11:05:00Z'});
  const failed=await api.finish(s=>s.hourlyScheduler.lastRun?.status==='retry_pending');assert.equal(failed.hourlyScheduler.lastRun.ticketsSent,0);
  assert.ok(failed.hourlyScheduler.lastRun.plans.every(p=>p.reason==='SPORTYBET_SOURCE_UNAVAILABLE'));
  const state=await api.rpc('state');assert.equal(state.bookings.length,0);assert.equal(state.messages.length,0);
  await api.rpc('configure',{failReads:false});await api.rpc('clock',{date:'2026-10-08T11:07:00Z'});
  await api.finish(s=>s.hourlyScheduler.lastRun?.status==='completed');assert.equal((await api.rpc('state')).bookings.length,3);
});
