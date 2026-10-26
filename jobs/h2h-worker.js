'use strict';
const {createH2hCache}=require('../lib/h2hCache');
const {failure}=require('../lib/h2hFailure');
async function runWorker({redis,collect=require('../lib/sportyH2h').collect,close=require('../lib/sportyH2h').closeBrowser,now=Date.now,maxFixtures=80,budgetMs=480000,fixtureTimeoutMs=60000,forceRetry=false,logger=console}={}){
 const store=createH2hCache({getRedis:async()=>redis,now}),started=now(),deadline=started+budgetMs,summary={startedAt:new Date(started).toISOString(),checked:0,saved:0,failed:0,skippedFresh:0,reasons:{}};
 // Seed from the shared public catalogue. Requests also enqueue exact candidate identities.
 const raw=await redis.get(require('../lib/sportyPublicCache').CACHE_KEY);if(raw){let catalog;try{catalog=JSON.parse(raw);}catch{}if(catalog){const groups=Object.values(catalog.sports||{}).map(s=>(s.fixtures||[]).filter(c=>Date.parse(c.kickoffUtc)>now()&&Date.parse(c.kickoffUtc)<now()+7*86400000).sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc)));const seed=[];while(seed.length<400&&groups.some(g=>g.length))for(const g of groups)if(g.length&&seed.length<400)seed.push(g.shift());await store.enqueue(seed);}}
 try{for(const id of (await store.pending()).slice(0,1000)){
  if(now()>=deadline||summary.checked>=maxFixtures)break;
  const c=await store.fixture(id);if(!c||Date.parse(c.kickoffUtc)<=now()){await store.remove(id);continue;}
  const cached=await store.readMany([c]);if(cached.evidence.has(String(id))){summary.skippedFresh++;await store.remove(id);continue;}
  const prior=cached.failures.get(String(id));if(!forceRetry&&prior&&now()-Date.parse(prior.failedAt)<900000)continue;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(fixtureTimeoutMs,deadline-now())));timer.unref?.();
  try{summary.checked++;const e=await collect(c,{signal:controller.signal});if(controller.signal.aborted)throw Object.assign(Error('H2H timed out'),{h2hReason:'page_timeout'});if(!require('../lib/h2hCache').usable(e,c,now()))throw Object.assign(Error('No verified worker history'),{h2hReason:'team_identity_unverified'});await store.put(e);summary.saved++;}
  catch(error){const f=failure(error);summary.failed++;logger.warn?.('[H2H fixture failed] '+JSON.stringify({eventId:id,sport:c.sport,reason:f.reason,stage:f.stage}));summary.reasons[f.reason]=(summary.reasons[f.reason]||0)+1;await store.failed(id,f);if(['browser_missing','browser_dependencies','browser_launch_failed','host_memory_pressure'].includes(f.reason))break;}
  finally{clearTimeout(timer);}
 }}finally{await close();}
 summary.finishedAt=new Date(now()).toISOString();summary.pending=(await store.pending()).length;summary.status=summary.failed&&!summary.saved?'failed':summary.pending?'partial':'completed';await store.saveStatus(summary);logger.info?.('[H2H external worker] '+JSON.stringify(summary));return summary;
}
async function main(){process.env.SPORTYBET_H2H_WORKER='true';if(!process.env.REDIS_URL)throw Error('Set the GitHub repository secret REDIS_URL to the same Redis connection used by Render.');const redis=require('redis').createClient({url:process.env.REDIS_URL,socket:{connectTimeout:10000,reconnectStrategy:()=>false}});redis.on('error',()=>console.error('H2H Redis connection unavailable'));try{await redis.connect();const result=await runWorker({redis,forceRetry:process.env.H2H_WORKER_FORCE_RETRY==='true',maxFixtures:Math.max(1,Math.min(200,Number(process.env.H2H_WORKER_MAX_FIXTURES)||80))});if(result.status==='failed')process.exitCode=1;}finally{if(redis.isOpen)await redis.quit().catch(()=>redis.disconnect());}}
if(require.main===module)main().catch(()=>{console.error('H2H worker could not complete. Check REDIS_URL and the worker summary above; no web-server browser was started.');process.exitCode=1;});
module.exports={runWorker};
