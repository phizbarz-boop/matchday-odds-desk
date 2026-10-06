'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const path=require('node:path'),{tmpdir}=require('node:os');

test('the real app schedules all five dummy-account tickets directly without GitHub or an API trigger',async t=>{
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
  const complete=async hourKey=>{
    for(let attempt=0;attempt<200;attempt++) {
      const {body}=await get('/api/telegram/status');
      if(body.hourlyScheduler.lastRun?.hourKey===hourKey&&body.hourlyScheduler.lastRun?.status==='completed')return body;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw Error('Direct scheduler did not complete: '+logs);
  };
  await t.test('startup after the due minute books and sends five categories from the dummy session',async()=>{
    const status=await complete('2026-10-06T17'),state=await rpc('state');
    assert.equal(state.messages.length,5);assert.equal(state.bookings.length,5);assert.ok(state.sessionChecks>0);
    assert.equal(status.rules.hourly.scheduler,'app-server');assert.equal(status.hourlyScheduler.source,'app-server');
    assert.equal(status.hourlyScheduler.running,true);assert.equal(status.hourlyScheduler.minute,0);
    assert.equal(status.hourlyScheduler.lastRun.ticketsSent,5);assert.equal(status.hourlyScheduler.lastRun.plans.length,5);
    assert.match(state.messages[0],/QC ICE HOCKEY/);assert.match(state.messages[4],/LIVE ALL SPORTS 85%/);
    assert.equal(state.hashes.find(([key])=>key.includes('quick-cash:codes'))[1].length,5);
  });
  await t.test('shared run status is protected and a scheduled HTTP retry cannot duplicate direct sends',async()=>{
    assert.equal((await get('/api/telegram/quick-cash/run-status')).status,401);
    const status=await get('/api/telegram/quick-cash/run-status',true);
    assert.equal(status.status,200);assert.equal(status.body.locked,true);assert.equal(status.body.state.ticketsSent,5);
    assert.equal(status.body.plans.length,5);assert.ok(status.body.plans.every(plan=>plan.status==='completed'));
    const repeat=await post();assert.equal(repeat.body.reason,'already_processed_this_hour');
    assert.equal((await rpc('state')).messages.length,5);
  });
  await t.test('the next server hour reads again and preserves both hours in Today’s Codes',async()=>{
    await rpc('clock',{date:'2026-10-06T17:00:00Z'});await complete('2026-10-06T18');
    const state=await rpc('state');assert.equal(state.messages.length,10);assert.equal(state.bookings.length,10);
    const codes=state.hashes.find(([key])=>key.includes('quick-cash:codes'))[1].map(([,raw])=>JSON.parse(raw));
    assert.equal(codes.length,10);assert.equal(codes.filter(code=>code.hourKey==='2026-10-06T17').length,5);
    assert.equal(codes.filter(code=>code.hourKey==='2026-10-06T18').length,5);
  });
  await t.test('manual all-category runs remain available independently of automatic hourly delivery',async()=>{
    const manual=await post({'x-matchday-run-mode':'manual','x-matchday-run-id':'direct-manual-1'});
    assert.equal(manual.status,200);assert.equal(manual.body.runMode,'manual');assert.equal(manual.body.ticketsSent,5);
    await rpc('clock',{date:'2026-10-06T17:30:00Z'});
    const state=await rpc('state');assert.equal(state.messages.length,15);assert.equal(state.bookings.length,15);
    const tickets=state.hashes.find(([key])=>key==='telegram:tracked-tickets:v2')[1].map(([,raw])=>JSON.parse(raw));
    assert.equal(tickets.length,15);assert.ok(tickets.every(ticket=>ticket.delivery==='posted'));
    const {buildPerformanceReport,reportWindow}=require('../lib/telegramPerformance');
    const report=buildPerformanceReport(tickets,reportWindow(new Date('2026-10-07T01:00:00Z')));
    assert.equal(report.period.pendingStake,1500);
  });
});
