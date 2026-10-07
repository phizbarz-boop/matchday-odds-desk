'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const path=require('node:path'),{tmpdir}=require('node:os');

test('hourly Telegram QC/live is removed even when legacy hourly settings are enabled',async t=>{
  const scratch=mkdtempSync(path.join(tmpdir(),'plot207-direct-hourly-'));
  const child=fork(path.join(__dirname,'fixtures/hourly-qc-api-server.js'),[],{cwd:path.join(__dirname,'..'),silent:true,
    env:{...process.env,PORT:'0',REDIS_URL:'redis://test-only',TELEGRAM_BOT_TOKEN:'test-only',TELEGRAM_CHAT_ID:'test-only',
      TELEGRAM_JOB_SECRET:'test-status-secret',TELEGRAM_HOURLY_ENABLED:'true',TELEGRAM_HOURLY_MINUTE:'0',
      TEST_HOURLY_CLOCK:'2026-10-06T16:32:00Z',TEST_HOURLY_ALL_SPORTS:'true',
      SPORTYBET_PHONE:'',SPORTYBET_PASSWORD:'',SPORTYBET_PROXY_URL:'',SPORTYBET_BOOTSTRAP_COOKIES:'',
      SPORTYBET_SESSION_FILE:path.join(scratch,'session.json'),SPORTYBET_LIVE_MAX_PAGES:'1',GITHUB_ACTIONS:''}});
  let logs='';child.stdout.on('data',data=>{logs+=data;});child.stderr.on('data',data=>{logs+=data;});
  t.after(()=>{child.kill();rmSync(scratch,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);
    child.once('message',message=>{clearTimeout(timer);resolve(message.port);});child.once('error',reject);});
  let sequence=0;const pending=new Map();
  child.on('message',message=>{if(pending.has(message.id)){pending.get(message.id)(message.data);pending.delete(message.id);}});
  const rpc=(action,extra={})=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);child.send({id,action,...extra});});
  const get=async(route,authorized=false)=>{
    const response=await fetch(`http://127.0.0.1:${port}${route}`,{headers:authorized?{'x-telegram-job-secret':'test-status-secret'}:{}});
    return {status:response.status,body:await response.json()};
  };
  const post=async(headers={})=>{
    const response=await fetch(`http://127.0.0.1:${port}/api/telegram/quick-cash`,{method:'POST',
      headers:{'Content-Type':'application/json','x-telegram-job-secret':'test-status-secret',...headers},body:'{}'});
    return {status:response.status,body:await response.json()};
  };
  await t.test('startup does not authenticate, book or send hourly tickets',async()=>{
    const status=await get('/api/telegram/status'),state=await rpc('state');
    assert.equal(state.messages.length,0);assert.equal(state.bookings.length,0);assert.equal(state.sessionChecks,0);
    assert.equal(status.body.targets.length,7);assert.equal(status.body.hourlyScheduler,undefined);assert.equal(status.body.rules.hourly,undefined);
    assert.deepEqual(status.body.next12hRules.times,['07:00','18:00']);assert.equal(status.body.rules.performance.stakePerTicket,100);
  });
  await t.test('scheduled and manual legacy endpoints reject without booking or posting',async()=>{
    for(const headers of [{},{'x-matchday-run-mode':'manual','x-matchday-run-id':'retired-manual'}]) {
      const result=await post(headers);assert.equal(result.status,410);assert.equal(result.body.reason,'hourly_telegram_picks_removed');
    }
    assert.equal((await get('/api/telegram/quick-cash/run-status')).status,401);
    const status=await get('/api/telegram/quick-cash/run-status',true);assert.equal(status.status,200);assert.equal(status.body.enabled,false);
  });
  await t.test('crossing subsequent hours never generates codes or sends messages',async()=>{
    await rpc('clock',{date:'2026-10-06T17:00:00Z'});await rpc('clock',{date:'2026-10-06T18:05:00Z'});
    const state=await rpc('state');assert.equal(state.messages.length,0);assert.equal(state.bookings.length,0);assert.equal(state.sessionChecks,0);
    assert.ok(!state.hashes.some(([key])=>key.includes('quick-cash:codes')));
  });
});
