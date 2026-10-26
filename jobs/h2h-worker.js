'use strict';
const {createH2hCache}=require('../lib/h2hCache');
const {failure}=require('../lib/h2hFailure');
async function runWorker({redis,collect=require('../lib/sportyH2h').collect,close=require('../lib/sportyH2h').closeBrowser,now=Date.now,maxFixtures=10000,budgetMs=690000,fixtureTimeoutMs=60000,forceRetry=false,targetEventId=null,discover=null,logger=console}={}){
 const store=createH2hCache({getRedis:async()=>redis,now}),started=now(),deadline=started+budgetMs,summary={startedAt:new Date(started).toISOString(),checked:0,saved:0,failed:0,skippedFresh:0,reasons:{}};
 // Discovery is injected only by the external worker entry point; tests and
 // diagnostic single-fixture runs do not make unrelated public requests.
 if(discover&&!targetEventId){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);timer.unref?.();try{let startPages={};try{startPages=JSON.parse(await redis.get('sportybet:h2h:worker:v1:discovery-cursor')||'{}');}catch{}summary.discovery=await discover({now,startPages,signal:controller.signal,onFixtures:async rows=>{const current=await store.readMany(rows);await store.enqueue(rows.filter(c=>!current.evidence.has(String(c.eventId))));},logger});await redis.set('sportybet:h2h:worker:v1:discovery-cursor',JSON.stringify(Object.fromEntries(Object.entries(summary.discovery).map(([sport,st])=>[sport,st.nextPage||1]))),{EX:86400});}catch{summary.discoveryError='public_discovery_failed';}finally{clearTimeout(timer);}}
 const raw=await redis.get(require('../lib/sportyPublicCache').CACHE_KEY);if(raw){let catalog;try{catalog=JSON.parse(raw);}catch{}if(catalog)for(const sport of Object.values(catalog.sports||{})){const rows=(sport.fixtures||[]).filter(c=>Date.parse(c.kickoffUtc)>now()&&Date.parse(c.kickoffUtc)<now()+7*86400000);for(let i=0;i<rows.length;i+=1000){const batch=rows.slice(i,i+1000),current=await store.readMany(batch);await store.enqueue(batch.filter(c=>!current.evidence.has(String(c.eventId))));}}}
 const ids=targetEventId?[targetEventId]:await store.pending(),groups=new Map();
 const fixtureRows=await store.fixtures(ids);
 for(let i=0;i<ids.length;i++){const id=ids[i],c=fixtureRows[i];if(!c||Date.parse(c.kickoffUtc)<=now()){await store.remove(id);continue;}const sport=String(c.sport||'Unknown');if(!groups.has(sport))groups.set(sport,[]);groups.get(sport).push(c);}
 const queue=[];while([...groups.values()].some(g=>g.length))for(const g of groups.values())if(g.length)queue.push(g.shift());
 if(targetEventId&&!queue.length)summary.error='diagnostic_fixture_not_queued';
 if(discover&&!targetEventId&&!queue.length&&(summary.discoveryError||Object.values(summary.discovery||{}).length&&Object.values(summary.discovery).every(s=>s.error)))summary.error='public_discovery_unavailable';
 summary.queuedBySport=Object.fromEntries([...new Set(queue.map(c=>c.sport))].map(s=>[s,queue.filter(c=>c.sport===s).length]));
 let consecutiveWidgetBlocks=0;
 try{for(const c of queue){const id=c.eventId;
  if(now()>=deadline||summary.checked>=maxFixtures)break;
  const cached=await store.readMany([c]);if(cached.evidence.has(String(id))){summary.skippedFresh++;await store.remove(id);continue;}
  const prior=cached.failures.get(String(id));if(!forceRetry&&prior&&now()-Date.parse(prior.failedAt)<900000)continue;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(fixtureTimeoutMs,deadline-now())));timer.unref?.();
  try{summary.checked++;const e=await collect(c,{signal:controller.signal});if(controller.signal.aborted)throw Object.assign(Error('H2H timed out'),{h2hReason:'page_timeout'});if(!require('../lib/h2hCache').usable(e,c,now()))throw Object.assign(Error('No verified worker history'),{h2hReason:'team_identity_unverified'});await store.put(e);summary.saved++;consecutiveWidgetBlocks=0;}
  catch(error){const f=failure(error);summary.failed++;logger.warn?.('[H2H fixture failed] '+JSON.stringify({eventId:id,sport:c.sport,reason:f.reason,stage:f.stage}));summary.reasons[f.reason]=(summary.reasons[f.reason]||0)+1;await store.failed(id,f);consecutiveWidgetBlocks=f.reason==='h2h_widget_loader_blocked'?consecutiveWidgetBlocks+1:0;if(consecutiveWidgetBlocks>=3){summary.outcome='widget_loader_blocked_repeatedly';break;}if(['browser_missing','browser_dependencies','browser_launch_failed','host_memory_pressure'].includes(f.reason))break;}
  finally{clearTimeout(timer);}
 }}finally{await close();}
 summary.finishedAt=new Date(now()).toISOString();summary.pending=(await store.pending()).length;summary.status=summary.error?'failed':summary.failed&&!summary.saved?'failed':summary.pending?'partial':'completed';await store.saveStatus(summary);logger.info?.('[H2H external worker] '+JSON.stringify(summary));return summary;
}
async function main(){process.env.SPORTYBET_H2H_WORKER='true';const target=String(process.env.H2H_DEBUG_EVENT_ID||'').trim();if(target&&!/^sr:match:\d+$/.test(target))throw Error('Invalid H2H diagnostic event ID');if(!process.env.REDIS_URL)throw Error('Set the GitHub repository secret REDIS_URL to the same Redis connection used by Render.');const redis=require('redis').createClient({url:process.env.REDIS_URL,socket:{connectTimeout:10000,reconnectStrategy:()=>false}});redis.on('error',()=>console.error('H2H Redis connection unavailable'));try{await redis.connect();const result=await runWorker({redis,targetEventId:target||null,forceRetry:process.env.H2H_WORKER_FORCE_RETRY==='true',discover:require('../lib/h2hDiscovery').discover,budgetMs:690000,maxFixtures:Math.max(1,Math.min(10000,Number(process.env.H2H_WORKER_MAX_FIXTURES)||10000))});if(result.status==='failed')process.exitCode=1;}finally{if(redis.isOpen)await redis.quit().catch(()=>redis.disconnect());}}
if(require.main===module)main().catch(()=>{console.error('H2H worker could not complete. Check REDIS_URL and the worker summary above; no web-server browser was started.');process.exitCode=1;});
module.exports={runWorker};
