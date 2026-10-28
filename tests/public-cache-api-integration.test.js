'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fork}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
test('public prediction refresh keeps its three slots while automatic Telegram tickets are retired',async t=>{
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
  const coverage=await request('/api/sportybet/market-coverage');assert.equal(coverage.status,200);assert.ok(coverage.body.discoveredMarketInstances>0);assert.ok(coverage.body.markets.every(m=>Array.isArray(m.outcomes)));
  const predictions=await request('/api/predictions');assert.equal(predictions.body.readMode,'public-cache');assert.equal(predictions.body.matches.length,60);
  const status=(await request('/api/telegram/status')).body;assert.equal(status.targets.length,16);
  for(const date of ['2026-10-07T11:30:00Z','2026-10-07T16:30:00Z']){
    await rpc('clock',{date});await complete('/api/sportybet/public-cache/status',p=>p.scheduler.lastRun?.status==='completed'&&p.lastRun?.startedAt===date.replace('Z','.000Z'));
  }
  const state=await rpc('state');assert.equal(state.bookings.length,0);assert.equal(state.messages.length,0);
  assert.equal(state.data.filter(([key])=>key.startsWith('sportybet:public-refresh:done:')).length,3);
});
