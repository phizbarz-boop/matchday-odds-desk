'use strict';
const fs=require('node:fs'),path=require('node:path');
const {combine,assess}=require('./h2hEvidence');
const {failure}=require('./h2hFailure');
const FILE=process.env.SPORTYBET_H2H_FILE||path.join(__dirname,'..','data','sporty-h2h.json');
const pool=require('./h2hBrowserPool').createH2hBrowserPool({beforeLaunch:()=>require('./runtimeMemory').beforeBrowserLaunch(),launch:()=>{require('./sportyBrowserRuntime').configureBrowserPath();return require('playwright').chromium.launch(require('./h2hWorkerBrowser').launchOptions());}});
const cache=new Map(),pending=new Map();let loaded=false;
function urlFor(c){
 const sport=/hockey/i.test(c.sport)?'iceHockey':String(c.sport||'football').toLowerCase();
 if(!['football','basketball','tennis','handball','iceHockey','volleyball'].includes(sport)||!/^sr:match:\d+$/.test(String(c.eventId)))throw Error('Unsupported H2H fixture');
 const {slug}=require('./h2hFixtureIdentity');
 return `https://www.sportybet.com/ng/m/sport/${sport}/${slug(c.category||c.country||'International')}/${slug(c.tournament||'Match')}/${slug(c.home)}_vs_${slug(c.away)}/${c.eventId}`;
}
const {panelText,clickTab,readPanels}=require('./h2hPanels');
async function collect(c,{signal}={}){
 if(process.env.SPORTYBET_H2H_WORKER!=='true')throw Object.assign(Error('H2H browser belongs to the external worker'),{h2hReason:'external_worker_required'});
 let stage='browser_launch';
 try{
 return await pool.run(async page=>{
  const debug=require('./h2hDebug'),events=debug.watch(page);
  try{
  stage='page_load';const response=await page.goto(urlFor(c),{waitUntil:'domcontentloaded',timeout:20000});
  if(response&&response.status()>=400)throw Object.assign(Error('H2H page HTTP error'),{h2hReason:'page_http_error'});
  stage='stats_tab';
  if(!await clickTab(page,'stats',{signal,timeoutMs:10000}))throw Object.assign(Error('Stats tab unavailable'),{h2hReason:'stats_tab_unavailable'});
  stage='h2h_panels';const {oldText,newText,diagnostics}=await readPanels(page,{signal});
  stage='team_identity';
  // The route's slug is descriptive; verify the actual displayed match identity.
  await require('./h2hFixtureIdentity').verifyIdentity(page,c,{signal});
  const result=combine(oldText,newText,c);console.info('[H2H reader] '+JSON.stringify({eventId:c.eventId,...diagnostics,metrics:Object.keys(result.metrics),sampleCount:result.sampleCount}));return result;
  }catch(error){if(error.h2hReason==='h2h_panels_unavailable'){const source=require('./h2hWorkerBrowser').sourceFailure(events);if(source){Object.assign(error,source);stage=source.h2hStage;}}await debug.capture(page,{eventId:c.eventId,stage,error,events}).catch(()=>{});throw error;}
 },{signal});
 }catch(error){console.warn('[H2H reader] '+JSON.stringify({eventId:c.eventId,stage,reason:error.h2hReason||'h2h_read_failed',...(error.h2hDiagnostics||{})}));const detail=failure(error,stage);throw Object.assign(error,{h2hReason:detail.reason,h2hStage:detail.stage});}
}
async function read(c,options){
 if(!loaded){loaded=true;try{for(const e of JSON.parse(fs.readFileSync(FILE,'utf8')).events||[])cache.set(e.eventId,e);}catch{}}
 const old=cache.get(String(c.eventId));if(old&&Date.now()-Date.parse(old.capturedAt)<900000)return old;
 if(!pending.has(String(c.eventId)))pending.set(String(c.eventId),collect(c,options).then(e=>{cache.set(e.eventId,e);for(const [id,item] of cache)if(Date.now()-Date.parse(item.capturedAt)>=900000)cache.delete(id);while(cache.size>200)cache.delete(cache.keys().next().value);fs.mkdirSync(path.dirname(FILE),{recursive:true});const temp=FILE+'.tmp';fs.writeFileSync(temp,JSON.stringify({events:[...cache.values()].filter(x=>Date.now()-Date.parse(x.capturedAt)<900000)}));fs.renameSync(temp,FILE);return e;}).finally(()=>pending.delete(String(c.eventId))));
 return pending.get(String(c.eventId));
}
let workerCache=require('./h2hCache').createH2hCache();
function configureCache(options){workerCache=require('./h2hCache').createH2hCache(options);}
async function checkCached(rows,{signal,now=()=>new Date(),logger=console}={}){
 if(process.env.SPORTYBET_H2H_CACHE_ENABLED==='false')return rows;
 let evidence=new Map(),failures=new Map(),unavailable=false,timer;
 try{if(signal?.aborted)throw Error('Cancelled');const result=await Promise.race([workerCache.readAndQueue(rows),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('H2H cache timeout')),3000);})]);evidence=result.evidence;failures=result.failures;unavailable=Boolean(result.queueUnavailable);}catch{unavailable=true;logger.warn?.('[SportyBet H2H cache] Redis history unavailable; original estimates retained');}finally{clearTimeout(timer);}
 const result=rows.map(c=>{const id=String(c.eventId),e=evidence.get(id),r=assess(c,e,now());r.h2hCheck.source='external_worker_cache';if(e)r.h2hCheck.capturedAt=e.capturedAt;r.h2hCheck.attempted=Boolean(e);if(!e){const f=failures.get(id);r.h2hCheck.status=f?'unavailable_worker_history':'not_checked';r.h2hCheck.reason=f?.reason||(unavailable?'h2h_cache_unavailable':'awaiting_h2h_worker');r.h2hCheck.failureMessage=f?.message||(unavailable?'Shared H2H storage is unavailable. Original estimate retained.':'Queued for the separate H2H worker; no verified saved history yet.');}return r;});
 for(const k of Object.keys(rows))if(!/^\d+$/.test(k))result[k]=rows[k];
 result.h2hCoverage={source:'external_worker_cache',fixturesRequested:new Set(rows.map(c=>c.eventId)).size,fixturesChecked:evidence.size,verified:result.filter(c=>c.h2hCheck.verified===true).length,unverified:result.filter(c=>c.h2hCheck.verified!==true).length,blocked:result.filter(c=>c.h2hCheck.allowed===false).length,queuedFixtures:unavailable?0:Math.min(1000,new Set(rows.filter(c=>!evidence.has(String(c.eventId))).map(c=>c.eventId)).size)};return result;
}
async function checkCandidates(rows,{signal,maxFixtures=Number(process.env.SPORTYBET_H2H_MAX_FIXTURES)||40,budgetMs=90000,collectEvidence=null,now=()=>new Date(),logger=console}={}){
 if(!collectEvidence)return checkCached(rows,{signal,now,logger});
 if(process.env.SPORTYBET_H2H_ENABLED==='false')return rows;
 const deadline=Date.now()+budgetMs,groups=new Map(),unique=new Map();
 for(const c of [...rows].sort((a,b)=>Number(b.probability)-Number(a.probability)))if(!unique.has(String(c.eventId)))unique.set(String(c.eventId),c);
 for(const c of unique.values()){const sport=require('./telegramMixedSelector').normalizedSport(c)||'unknown';if(!groups.has(sport))groups.set(sport,[]);groups.get(sport).push(c);}
 const fixtures=[];while(fixtures.length<maxFixtures&&[...groups.values()].some(a=>a.length))for(const group of groups.values())if(group.length&&fixtures.length<maxFixtures)fixtures.push(group.shift());
 const evidence=new Map(),failures=new Map();let index=0,unavailable=null;
 await Promise.all([0].map(async()=>{while(index<fixtures.length&&Date.now()<deadline&&!signal?.aborted){const c=fixtures[index++];try{evidence.set(String(c.eventId),await collectEvidence(c,{signal}));}catch(error){const detail=failure(error);failures.set(String(c.eventId),detail);evidence.set(String(c.eventId),null);if(['host_memory_pressure','browser_missing','browser_dependencies','browser_launch_failed'].includes(detail.reason)){unavailable=detail;break;}}}}));
 if(collectEvidence===read)await pool.closeIdle();
 const result=rows.map(c=>{const attempted=evidence.has(String(c.eventId)),r=assess(c,evidence.get(String(c.eventId)),now());r.h2hCheck.attempted=attempted;const failed=failures.get(String(c.eventId));if(failed){r.h2hCheck.reason=failed.reason;r.h2hCheck.failureMessage=failed.message;r.h2hCheck.stage=failed.stage;}if(!attempted){r.h2hCheck.status='not_checked';r.h2hCheck.reason=unavailable?.reason||(signal?.aborted?'request_cancelled':'check_limit_or_time_budget');if(unavailable)r.h2hCheck.failureMessage=unavailable.message;}return r;});
 for(const key of Object.keys(rows))if(!/^\d+$/.test(key))result[key]=rows[key];
 const failureCounts={};for(const f of failures.values())failureCounts[f.reason]=(failureCounts[f.reason]||0)+1;if(failures.size)logger.warn?.('[SportyBet H2H] '+JSON.stringify({attempted:evidence.size,failed:failures.size,reasons:failureCounts}));
 result.h2hCoverage={failures:failureCounts,fixturesRequested:new Set(rows.map(c=>c.eventId)).size,fixturesChecked:evidence.size,verified:result.filter(c=>c.h2hCheck.verified!==false).length,unverified:result.filter(c=>c.h2hCheck.verified===false).length,blocked:result.filter(c=>!c.h2hCheck.allowed).length};return result;
}
module.exports={checkCandidates,urlFor,collect,panelText,configureCache,checkCached,closeBrowser:()=>pool.closeIdle()};
