'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fork}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
test('the real app refreshes public data and sends two additional six-ticket Telegram batches without GitHub',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'public-schedule-api-'));
  const child=fork(path.join(__dirname,'fixtures/public-cache-api-server.js'),[],{cwd:path.join(__dirname,'..'),silent:true,
    env:{...process.env,PORT:'0',REDIS_URL:'redis://test-only',TELEGRAM_BOT_TOKEN:'fixture-only',TELEGRAM_CHAT_ID:'fixture-only',TELEGRAM_JOB_SECRET:'fixture-job-secret',
      TELEGRAM_WEBHOOK_SECRET:'fixture-hook-secret',TELEGRAM_HOURLY_ENABLED:'false',SPORTYBET_PUBLIC_CACHE_ENABLED:'true',TELEGRAM_NEXT12H_ENABLED:'true',
      SPORTYBET_PUBLIC_DETAIL_DELAY_MS:'0',SPORTYBET_PUBLIC_CACHE_FILE:path.join(directory,'catalog.json'),REFRESH_SECRET:'fixture-refresh-secret',
      SPORTYBET_PHONE:'2348000000000',SPORTYBET_PASSWORD:'fixture-password',SPORTYBET_PROXY_URL:'',SPORTYBET_BOOTSTRAP_COOKIES:'',SPORTYBET_SESSION_FILE:path.join(directory,'session.json')}});
  let logs='';child.stdout.on('data',d=>{logs+=d;});child.stderr.on('data',d=>{logs+=d;});
  t.after(()=>{child.kill();fs.rmSync(directory,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(logs)),10000);child.once('message',m=>{clearTimeout(timeout);resolve(m.port);});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Server exited '+code+': '+logs));});});
  const pending=new Map();let sequence=0;child.on('message',m=>{pending.get(m.id)?.(m.data);pending.delete(m.id);});
  const rpc=(action,extra={})=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);child.send({id,action,...extra});});
  const request=async(route,body,headers={})=>{const response=await fetch(`http://127.0.0.1:${port}${route}`,body===undefined?{headers}:{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const complete=async(route,predicate)=>{for(let i=0;i<200;i++){const r=await request(route);if(predicate(r.body))return r.body;await new Promise(r=>setTimeout(r,10));}assert.fail(logs);};
  assert.equal((await request('/api/telegram/next-12h-picks',{})).status,401);
  assert.equal((await request('/api/refresh',{})).status,401);
  await rpc('clock',{date:'2026-10-07T05:30:00Z'});
  const publicStatus=await complete('/api/sportybet/public-cache/status',p=>p.lastRun?.status==='completed');
  assert.equal(publicStatus.loginRequired,false);assert.equal(Object.keys(publicStatus.sports).length,6);assert.deepEqual(publicStatus.scheduler.times,['06:30','12:30','17:30']);
  assert.equal((await rpc('state')).sessionChecks,0);assert.ok(fs.existsSync(path.join(directory,'catalog.json')));
  const predictions=await request('/api/predictions');assert.equal(predictions.body.readMode,'public-cache');assert.equal(predictions.body.matches.length,24);
  await rpc('clock',{date:'2026-10-07T06:00:00Z'});
  let status=await complete('/api/telegram/status',p=>p.next12hScheduler.lastRun?.slotTime==='07:00'&&p.next12hScheduler.lastRun.status==='completed');
  assert.equal(status.next12hScheduler.lastRun.ticketsSent,6,JSON.stringify(status));
  let state=await rpc('state');assert.equal(state.messages.length,6);assert.equal(state.bookings.length,6);assert.equal(state.sessionChecks,0);
  const repeated=await request('/api/telegram/next-12h-picks',{}, {'x-telegram-job-secret':'fixture-job-secret'});assert.equal(repeated.body.reason,'already_processed_this_slot');
  await rpc('daily',{date:'2026-10-07',codes:[{targetOdds:'1.30–5.00 SAFE',combinedOdds:1.5,shareCode:'SAFE-PRESERVED'}]});
  await request('/api/telegram/bot/webhook',{callback_query:{id:'fixture-callback',data:'action:dailycodes',from:{id:6001},message:{chat:{id:6001},text:'/start'}}},{'x-telegram-bot-api-secret-token':'fixture-hook-secret'});
  for(let i=0;i<100;i++){state=await rpc('state');if(state.aiMessages.length)break;await new Promise(r=>setTimeout(r,10));}
  const text=state.aiMessages.at(-1);assert.match(text,/SAFE-PRESERVED/);assert.match(text,/PUBLIC-TEST-6/);assert.match(text,/NEXT 12H/);assert.doesNotMatch(text,/🔒 NEXT 12H/);
  for(const date of ['2026-10-07T11:30:00Z','2026-10-07T16:30:00Z']){
    await rpc('clock',{date});await complete('/api/sportybet/public-cache/status',p=>p.scheduler.lastRun?.status==='completed'&&p.lastRun?.startedAt===date.replace('Z','.000Z'));
  }
  await rpc('clock',{date:'2026-10-07T17:00:00Z'});
  status=await complete('/api/telegram/status',p=>p.next12hScheduler.lastRun?.slotTime==='18:00'&&p.next12hScheduler.lastRun.status==='completed');
  assert.equal(status.next12hScheduler.lastRun.ticketsSent,6,JSON.stringify(status));state=await rpc('state');
  assert.equal(state.bookings.length,12);assert.equal(state.messages.length,12);
  assert.equal(state.sessionChecks,0);
  const dailyFields=state.hashes.find(([key])=>key==='telegram:next12h:codes:2026-10-07')[1];assert.equal(dailyFields.length,12);
  assert.equal(state.data.filter(([key])=>key.startsWith('sportybet:public-refresh:done:')).length,3);
  const tracked=state.hashes.find(([key])=>key==='telegram:tracked-tickets:v2')[1].map(([,raw])=>JSON.parse(raw));assert.equal(tracked.length,12);assert.ok(tracked.every(p=>p.delivery==='posted'));
  const asyncHeaders={'x-telegram-job-secret':'fixture-job-secret','x-matchday-run-mode':'manual','x-matchday-run-id':'gh-next12h-test',Prefer:'respond-async',Connection:'close'};
  const accepted=await request('/api/telegram/next-12h-picks',{},asyncHeaders);assert.equal(accepted.status,202);
  assert.equal((await request(accepted.body.statusUrl)).status,401);
  assert.ok([200,202].includes((await request('/api/telegram/next-12h-picks',{},asyncHeaders)).status));
  let finished;
  for(let i=0;i<300;i++){finished=await request(accepted.body.statusUrl,undefined,{'x-telegram-job-secret':'fixture-job-secret'});if(finished.status!==202)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(finished.status,200,JSON.stringify(finished.body));assert.equal(finished.body.ticketsSent,6);
  const repeatedAsync=await request('/api/telegram/next-12h-picks',{},asyncHeaders);assert.equal(repeatedAsync.body.runRequestStatus,'completed');
  state=await rpc('state');assert.equal(state.bookings.length,18);assert.equal(state.messages.length,18);assert.equal(state.sessionChecks,0);
});
