'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fork}=require('node:child_process'),{mkdtempSync,rmSync,readFileSync}=require('node:fs');
const path=require('node:path'),{tmpdir}=require('node:os');
test('hourly QC creates current codes, sends to Telegram and preserves Today’s Codes',async t=>{
  const scratch=mkdtempSync(path.join(tmpdir(),'plot207-qc-api-'));
  const child=fork(path.join(__dirname,'fixtures/hourly-qc-api-server.js'),[],{cwd:path.join(__dirname,'..'),silent:true,
    env:{...process.env,PORT:'0',REDIS_URL:'redis://test-only',TELEGRAM_JOB_SECRET:'qc-secret',TELEGRAM_WEBHOOK_SECRET:'hook-secret',
      SPORTYBET_PHONE:'',SPORTYBET_PASSWORD:'',SPORTYBET_PROXY_URL:'',SPORTYBET_BOOTSTRAP_COOKIES:'',
      SPORTYBET_SESSION_FILE:path.join(scratch,'session.json'),SPORTYBET_LIVE_MAX_PAGES:'1'}});
  let logs='';child.stdout.on('data',d=>{logs+=d;});child.stderr.on('data',d=>{logs+=d;});
  t.after(()=>{child.kill();rmSync(scratch,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);child.once('message',m=>{clearTimeout(timer);resolve(m.port);});child.once('error',reject);});
  let sequence=0;const pending=new Map();
  child.on('message',m=>{if(pending.has(m.id)){pending.get(m.id)(m.data);pending.delete(m.id);}});
  const rpc=(action,extra={})=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);child.send({id,action,...extra});});
  const post=async(route,body={},headers={})=>{const r=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const hourly=(body={})=>post('/api/telegram/quick-cash',body,{'x-telegram-job-secret':'qc-secret'});
  let generated;
  await t.test('job uses 0%, generates a booking, sends and stores its WAT hour',async()=>{
    generated=await hourly({minProbability:90});assert.equal(generated.status,200,JSON.stringify(generated.body));
    assert.equal(generated.body.sent,true);assert.equal(generated.body.minProbability,0);assert.match(generated.body.shareCode,/QC-TEST-/);
    const state=await rpc('state');assert.equal(state.messages.length,1);assert.equal(state.bookings.length,1);
    assert.match(state.messages[0],/Minimum probability: 0%/);assert.match(state.messages[0],/SportyBet code: QC-TEST-/);
    const stored=state.hashes.find(([key])=>key.includes('quick-cash:codes'))[1];
    assert.equal(JSON.parse(stored[0][1]).hourKey,generated.body.hourKey);
  });
  await t.test('repeated hourly request never books or sends twice',async()=>{
    const repeat=await hourly();assert.equal(repeat.body.sent,false);assert.equal(repeat.body.reason,'already_processed_this_hour');
    const state=await rpc('state');assert.equal(state.bookings.length,1);assert.equal(state.messages.length,1);
  });
  await t.test('Today’s Codes reveals QC to Free users alongside daily codes after a daily rewrite',async()=>{
    await rpc('daily',{date:generated.body.hourKey.slice(0,10),codes:[{targetOdds:'2',combinedOdds:2.1,shareCode:'DAILY-TWO'}]});
    const before=(await rpc('state')).aiMessages.length;
    const ack=await post('/api/telegram/bot/webhook',{callback_query:{id:'test-cb',data:'action:dailycodes',from:{id:5001},message:{chat:{id:5001},text:'/start'}}},
      {'x-telegram-bot-api-secret-token':'hook-secret'});
    assert.equal(ack.status,200,JSON.stringify(ack.body));assert.equal(await rpc('await_ai',{after:before}),true);
    const text=(await rpc('state')).aiMessages.at(-1);assert.match(text,/DAILY-TWO/);assert.match(text,/QC-TEST-1/);
    assert.match(text,/0%/);assert.doesNotMatch(text,/🔒 QC/);
  });
  await t.test('scores changing before booking prevent a stale winning selection from being sent',async()=>{
    await rpc('configure',{flip:true,footballOnly:true});const before=await rpc('state');
    const result=await hourly();assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.sent,false);
    const after=await rpc('state');assert.equal(after.messages.length,before.messages.length);assert.equal(after.bookings.length,before.bookings.length);
  });
  await t.test('an empty live board skips the hour without sending an empty ticket',async()=>{
    await rpc('configure',{empty:true});const result=await hourly();assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.body.reason,'no_eligible_live_games');assert.equal((await rpc('state')).messages.length,1);
  });
  await t.test('website live mode rejects early games even at a zero probability floor',async()=>{
    await rpc('configure',{early:true});const picked=await post('/api/sportybet/auto-pick',{sports:['football'],liveMode:'live',minProbability:0,minEdge:-25,betTypes:['home_win'],targetOdds:1.05});
    assert.equal(picked.status,404,JSON.stringify(picked.body));assert.ok(picked.body.liveDiagnostics.selectionRules.halfwayRejected>0);
    assert.match(picked.body.hint,/halfway/);
  });
  await t.test('hourly tennis QC discovers its match format from current event markets',async()=>{
    await rpc('configure',{tennisOnly:true});const result=await hourly();
    assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.sent,true);
    assert.equal(result.body.selections,1);const state=await rpc('state');assert.equal(state.bookings.at(-1)[0].eventId,'sr:match:live-format-tennis');
  });
  await t.test('interactive tennis winner-only QC can prove its format and recheck it in a separate booking request',async()=>{
    const picked=await post('/api/sportybet/auto-pick',{sports:['tennis'],liveMode:'quick_cash',minProbability:0,minEdge:-25,betTypes:['tennis_winner'],targetOdds:1.05,maxSelections:1});
    assert.equal(picked.status,200,JSON.stringify(picked.body));assert.equal(picked.body.selections[0].liveState.bestOf,3);
    const booked=await post('/api/sportybet/book',{selections:picked.body.selections});
    assert.equal(booked.status,200,JSON.stringify(booked.body));assert.match(booked.body.shareCode,/QC-TEST-/);
  });
});
test('QC workflow requests the hourly endpoint and preserves the daily workflow',()=>{
  const root=path.join(__dirname,'..');
  const hourly=readFileSync(path.join(root,'.github/workflows/telegram-quick-cash.yml'),'utf8');
  assert.match(hourly,/cron: '5 \* \* \* \*'/);assert.match(hourly,/api\/telegram\/quick-cash/);assert.match(hourly,/x-telegram-job-secret/);
  assert.match(readFileSync(path.join(root,'.github/workflows/telegram-picks.yml'),'utf8'),/cron: '25 7 \* \* \*'/);
});
