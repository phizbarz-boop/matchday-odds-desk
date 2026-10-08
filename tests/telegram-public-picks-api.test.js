'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fork,spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
async function server(t,mode){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'telegram-public-direct-'));
  const child=fork(path.join(__dirname,'fixtures/public-cache-api-server.js'),[],{cwd:path.join(__dirname,'..'),silent:true,
    env:{...process.env,PORT:'0',REDIS_URL:'redis://fixture-only',TELEGRAM_BOT_TOKEN:'fixture-only',TELEGRAM_CHAT_ID:'fixture-only',TELEGRAM_JOB_SECRET:'fixture-job-secret',
      SPORTYBET_PUBLIC_CACHE_ENABLED:'true',TELEGRAM_NEXT12H_ENABLED:'true',PUBLIC_PICKS_TEST_MODE:mode,SPORTYBET_PUBLIC_CACHE_FILE:path.join(directory,'catalog.json'),
      SPORTYBET_STATS_FILE:path.join(directory,'stats.json'),SPORTYBET_SESSION_FILE:path.join(directory,'session.json'),SPORTYBET_PHONE:'2348000000000',SPORTYBET_PASSWORD:'fixture-password',
      SPORTYBET_BOOTSTRAP_COOKIES:'',SPORTYBET_PROXY_URL:'',SPORTYBET_MAX_PAGES:'1',SPORTYBET_PUBLIC_DETAIL_DELAY_MS:'0'}});
  let logs='';child.stdout.on('data',d=>{logs+=d;});child.stderr.on('data',d=>{logs+=d;});
  t.after(()=>{child.kill();fs.rmSync(directory,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);child.once('message',m=>{clearTimeout(timer);resolve(m.port);});child.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code+': '+logs));});});
  const base=`http://127.0.0.1:${port}`,pending=new Map();let sequence=0;
  child.on('message',m=>{pending.get(m.id)?.(m.data);pending.delete(m.id);});
  const rpc=(action,extra={})=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);child.send({id,action,...extra});});
  const request=async(route,body,extra={})=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-telegram-job-secret':'fixture-job-secret',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
  const finish=async route=>{for(let i=0;i<300;i++){const result=await request(route);if(result.status!==202)return result;await new Promise(r=>setTimeout(r,10));}assert.fail(logs);};
  const runWorkflow=endpoint=>new Promise((resolve,reject)=>{
    const runner=spawn('python3',['jobs/telegram-picks-runner.py','--endpoint',endpoint],{cwd:path.join(__dirname,'..'),env:{...process.env,
      MATCHDAY_BASE_URL:base,TELEGRAM_JOB_SECRET:'fixture-job-secret',GITHUB_RUN_ID:'gh-public-'+endpoint,GH_EVENT_NAME:'workflow_dispatch',
      TELEGRAM_POLL_SECONDS:'.01',TELEGRAM_REQUEST_TIMEOUT_SECONDS:'2',TELEGRAM_POLL_MAX_SECONDS:'8'}});
    let output='';runner.stdout.on('data',d=>{output+=d;});runner.stderr.on('data',d=>{output+=d;});runner.once('error',reject);runner.once('exit',code=>resolve({code,output}));
  });
  return {rpc,request,finish,runWorkflow,directory,logs:()=>logs};
}

test('next-12-hours workflow generates six public codes on a cold cache while another refresh owns the lease',async t=>{
  const api=await server(t,'locked-cache');
  const result=await api.runWorkflow('next-12h-picks');assert.equal(result.code,0,result.output+'\n'+api.logs());
  assert.match(result.output,/"ticketsSent": 6/);
  const status=(await api.request('/api/telegram/status')).body;
  assert.equal(status.next12hRules.cacheRequired,false);assert.equal(status.next12hRules.bookingMode,'public');assert.equal(status.next12hRules.dummySessionForBooking,false);
  const state=await api.rpc('state');assert.equal(state.bookings.length,6);assert.equal(state.messages.length,6);assert.equal(state.sessionChecks,0);
  assert.equal(state.data.find(([key])=>key==='sportybet:public-catalog:v1:refresh')[1],'another-refresh-worker');
  assert.ok(!fs.existsSync(path.join(api.directory,'catalog.json')),'ticket generation must not require a completed catalogue');
  assert.ok(state.bookings.every(rows=>rows.length<=40));
  const repeated=await api.runWorkflow('next-12h-picks');assert.equal(repeated.code,0,repeated.output);assert.equal((await api.rpc('state')).bookings.length,6);
});

test('app-server 07:00 next-12-hours slot completes while scheduled public cache refresh is waiting',async t=>{
  const api=await server(t,'locked-cache');await api.rpc('clock',{date:'2026-10-07T06:00:00Z'});
  let status;
  for(let i=0;i<300;i++){status=(await api.request('/api/telegram/status')).body;if(status.next12hScheduler.lastRun?.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(status.next12hScheduler.lastRun?.ticketsSent,6,JSON.stringify(status)+'\n'+api.logs());
  const cache=(await api.request('/api/sportybet/public-cache/status')).body;assert.equal(cache.lastRun.status,'waiting');assert.equal(cache.generatedAt,null);
  assert.equal((await api.rpc('state')).sessionChecks,0);
});

test('SAFE workflow uses public data without a cache or dummy session',async t=>{
  const api=await server(t,'safe');
  const result=await api.runWorkflow('daily-picks');assert.equal(result.code,0,result.output+'\n'+api.logs());assert.match(result.output,/"ticketsSent": 1/);
  const state=await api.rpc('state');assert.equal(state.bookings.length,1);assert.equal(state.messages.length,2);assert.equal(state.sessionChecks,0);
  assert.ok(!fs.existsSync(path.join(api.directory,'catalog.json')));assert.match(state.messages.at(-1),/PUBLIC-TEST-1/);
});

test('failed public reads report source diagnostics instead of a missing-cache error',async t=>{
  const api=await server(t,'source-failure');const submitted=await api.request('/api/telegram/next-12h-picks',{}, {Prefer:'respond-async','x-matchday-run-mode':'manual','x-matchday-run-id':'source-failed'});
  assert.equal(submitted.status,202);const result=await api.finish(submitted.body.statusUrl);
  assert.equal(result.status,502);assert.equal(result.body.code,'SPORTYBET_SOURCE_UNAVAILABLE');assert.ok(Object.keys(result.body.diagnostics.sourceErrors).length>0);
  assert.doesNotMatch(result.body.error,/cache is not ready/);const state=await api.rpc('state');assert.equal(state.bookings.length,0);assert.equal(state.messages.length,0);
});
