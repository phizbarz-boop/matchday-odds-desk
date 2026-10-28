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

test('every retired automated route rejects requests without scanning, booking or sending',async t=>{
 const api=await server(t,'locked-cache');
 for(const name of ['daily-picks','next-12h-picks','hourly-picks','quick-cash']){
  const denied=await api.request('/api/telegram/'+name,{}, {'x-telegram-job-secret':'wrong'});assert.equal(denied.status,401);
  const retired=await api.request('/api/telegram/'+name,{}, {'x-matchday-run-mode':'manual','x-matchday-run-id':'removed-'+name});assert.equal(retired.status,410);assert.equal(retired.body.ticketsSent,0);
 }
 assert.equal((await api.request('/api/telegram/three-hourly-picks',{}, {'x-telegram-job-secret':'wrong'})).status,401);
 const status=(await api.request('/api/telegram/status')).body;assert.equal(status.targets.length,16);assert.equal(status.next12hScheduler.enabled,false);assert.equal(status.hourlyScheduler.enabled,false);assert.equal(status.threeHourlyScheduler.enabled,false);
 const state=await api.rpc('state');assert.equal(state.bookings.length,0);assert.equal(state.messages.length,0);assert.equal(state.reads.length,0);
 for(const name of ['telegram-picks.yml','telegram-next-12h.yml','telegram-hourly-model-picks.yml'])assert.equal(fs.existsSync(path.join(__dirname,'../.github/workflows',name)),false);
});
