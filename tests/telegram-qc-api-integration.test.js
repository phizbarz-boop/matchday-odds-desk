'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fork}=require('node:child_process'),{mkdtempSync,rmSync,readFileSync}=require('node:fs');
const path=require('node:path'),{tmpdir}=require('node:os');
test('hourly removal preserves historical tickets, public results and interactive website QC',async t=>{
  const scratch=mkdtempSync(path.join(tmpdir(),'plot207-qc-api-'));
  const child=fork(path.join(__dirname,'fixtures/hourly-qc-api-server.js'),[],{cwd:path.join(__dirname,'..'),silent:true,
    env:{...process.env,PORT:'0',REDIS_URL:'redis://test-only',TELEGRAM_JOB_SECRET:'qc-secret',TELEGRAM_WEBHOOK_SECRET:'hook-secret',
      TELEGRAM_HOURLY_ENABLED:'false',SPORTYBET_PHONE:'',SPORTYBET_PASSWORD:'',SPORTYBET_PROXY_URL:'',SPORTYBET_BOOTSTRAP_COOKIES:'',
      SPORTYBET_SESSION_FILE:path.join(scratch,'session.json'),SPORTYBET_LIVE_MAX_PAGES:'1'}});
  let logs='';child.stdout.on('data',d=>{logs+=d;});child.stderr.on('data',d=>{logs+=d;});
  t.after(()=>{child.kill();rmSync(scratch,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);child.once('message',m=>{clearTimeout(timer);resolve(m.port);});child.once('error',reject);});
  let sequence=0;const pending=new Map();
  child.on('message',m=>{if(pending.has(m.id)){pending.get(m.id)(m.data);pending.delete(m.id);}});
  const rpc=(action,extra={})=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);child.send({id,action,...extra});});
  const post=async(route,body={},headers={})=>{const r=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  await t.test('retired hourly endpoint cannot book or send',async()=>{
    const result=await post('/api/telegram/quick-cash',{}, {'x-telegram-job-secret':'qc-secret'});
    assert.equal(result.status,410);assert.equal(result.body.reason,'hourly_telegram_picks_removed');
    const state=await rpc('state');assert.equal(state.messages.length,0);assert.equal(state.bookings.length,0);assert.equal(state.sessionChecks,0);
  });
  await t.test('previously sent codes remain visible after daily codes are rewritten',async()=>{
    await rpc('seed_tickets');
    const date=new Date().toISOString().slice(0,10);
    await rpc('daily',{date,codes:[{targetOdds:'1.30–5.00 SAFE',combinedOdds:1.5,shareCode:'DAILY-SAFE'},
      {targetOdds:'2',combinedOdds:2.1,shareCode:'RETIRED-TWO'}]});
    const before=(await rpc('state')).aiMessages.length;
    const ack=await post('/api/telegram/bot/webhook',{callback_query:{id:'test-cb',data:'action:dailycodes',from:{id:5001},message:{chat:{id:5001},text:'/start'}}},
      {'x-telegram-bot-api-secret-token':'hook-secret'});
    assert.equal(ack.status,200);assert.equal(await rpc('await_ai',{after:before}),true);
    const text=(await rpc('state')).aiMessages.at(-1);assert.match(text,/DAILY-SAFE/);assert.match(text,/QC-TEST-1/);
    assert.doesNotMatch(text,/tickets run hourly|RETIRED-TWO/);
  });
  await t.test('12-hour public results retain winners and 100-naira ROI without dummy login',async()=>{
    await rpc('report_configuration',{settled:true});
    const report=await post('/api/telegram/performance-report',{stake:9999},{'x-telegram-job-secret':'qc-secret'});
    assert.equal(report.status,200,JSON.stringify(report.body));assert.equal(report.body.sent,true);
    assert.equal(report.body.report.stakePerTicket,100);assert.equal(report.body.report.period.tickets,4);
    assert.equal(report.body.report.period.counts.won,2);assert.equal(report.body.report.period.counts.lost,1);assert.equal(report.body.report.period.counts.push,1);
    assert.equal(report.body.report.period.stake,400);assert.equal(report.body.report.period.pendingStake,0);
    assert.equal(report.body.report.period.returns,400);assert.equal(report.body.report.period.profit,0);
    const state=await rpc('state');assert.equal(state.sessionChecks,0);assert.equal(state.bookings.length,0);
    const text=state.messages.at(-1);assert.match(text,/12-HOUR RESULTS/);assert.match(text,/₦100 per sent ticket/);
    assert.match(text,/QC FOOTBALL · QC-TEST-1/);assert.match(text,/Closest shot: QC FOOTBALL · QC-TEST-2/);
    const repeat=await post('/api/telegram/performance-report',{}, {'x-telegram-job-secret':'qc-secret'});
    assert.equal(repeat.body.reason,'already_reported_this_period');assert.equal((await rpc('state')).messages.length,state.messages.length);
  });
  await t.test('Telegram advertises SAFE, next-12h and the new three hourly model targets',async()=>{
    const response=await fetch(`http://127.0.0.1:${port}/api/telegram/status`),data=await response.json();
    assert.equal(data.targets.length,10);assert.deepEqual(data.rules.hourly.plans.map(p=>p.targetOdds),[3,3,1000]);
    assert.deepEqual(data.next12hRules.targets.map(p=>p.targetOdds),[10000,2500,500,100,100,100]);
    assert.equal(data.rules.performance.stakePerTicket,100);assert.equal(data.hourlyScheduler.running,false);
  });
  await t.test('website live mode still rejects early games at a zero probability floor',async()=>{
    await rpc('configure',{early:true});const picked=await post('/api/sportybet/auto-pick',{sports:['football'],liveMode:'live',minProbability:0,minEdge:-25,betTypes:['home_win'],targetOdds:1.05});
    assert.equal(picked.status,404,JSON.stringify(picked.body));assert.ok(picked.body.liveDiagnostics.selectionRules.halfwayRejected>0);
    assert.match(picked.body.hint,/halfway/);
  });
  await t.test('interactive tennis QC analyzes and books without the dummy account',async()=>{
    await rpc('configure',{tennisOnly:true});const before=await rpc('state');
    const picked=await post('/api/sportybet/auto-pick',{sports:['tennis'],liveMode:'quick_cash',minProbability:0,minEdge:-25,betTypes:['tennis_winner'],targetOdds:1.05,maxSelections:1});
    assert.equal(picked.status,200,JSON.stringify(picked.body));assert.equal(picked.body.selections[0].liveState.bestOf,3);
    assert.equal((await rpc('state')).sessionChecks,before.sessionChecks);
    const booked=await post('/api/sportybet/book',{selections:picked.body.selections});
    assert.equal(booked.status,200,JSON.stringify(booked.body));assert.match(booked.body.shareCode,/QC-TEST-/);
    assert.equal((await rpc('state')).sessionChecks,before.sessionChecks);
  });
});
