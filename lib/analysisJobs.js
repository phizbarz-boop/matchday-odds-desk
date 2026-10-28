'use strict';
const crypto=require('node:crypto');
function createAnalysisJobs({runInScope=fn=>fn(),getRedis=null,now=Date.now,maxJobs=100,maxActive=1,timeoutMs=240000,ttlMs=1800000,storageTimeoutMs=6500,leaseSeconds=45,heartbeatMs=10000}={}){
 const jobs=new Map();let active=0;
 const prefix='sportybet:analysis-job:v2:',ttlSeconds=Math.ceil(ttlMs/1000),key=id=>prefix+id;
 async function bounded(fn){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Analysis storage unavailable')),storageTimeoutMs);})]);}finally{clearTimeout(timer);}}
 const clean=()=>{for(const [id,j] of jobs)if(j.finishedAt!=null&&now()-j.finishedAt>ttlMs)jobs.delete(id);};
 const unavailable=res=>res.status(503).json({error:'Analysis job storage is temporarily unavailable. Please retry shortly.',code:'ANALYSIS_STORAGE_UNAVAILABLE'});
 function reply(j,res){if(j.result)return res.status(j.result.status).json(j.result.body);return res.status(202).json({jobId:j.id,status:'running',statusUrl:'/api/sportybet/analysis-jobs/'+j.id});}
 const missing=res=>res.status(404).json({error:'This analysis result is no longer available. The analysis can be restarted safely.',code:'ANALYSIS_JOB_NOT_FOUND'});
 function status(req,res){clean();res.set('Cache-Control','no-store');const id=String(req.params.id||''),j=jobs.get(id);if(j)return reply(j,res);if(!getRedis)return missing(res);
  return (async()=>{const redis=await bounded(getRedis);if(!redis)return missing(res);const raw=await bounded(()=>redis.get(key(id)));if(!raw)return missing(res);const saved=JSON.parse(raw);if(saved.result)return reply(saved,res);const owner=await bounded(()=>redis.get(key(id)+':owner'));if(owner!==saved.owner||now()-saved.startedAt>timeoutMs+leaseSeconds*1000)return res.status(410).json({error:'The analysis worker is no longer responding. Restarting this analysis is safe; no booking was submitted by this job.',code:'ANALYSIS_INTERRUPTED'});return reply(saved,res);})().catch(()=>unavailable(res));
 }
 function wrap(handler){return async(req,res)=>{
  if(req.headers['x-plot207-background']!=='1')return handler(req,res);
  clean();for(const [id,j] of jobs){if(jobs.size<maxJobs)break;if(j.finishedAt!=null)jobs.delete(id);}
  if(active>=maxActive||jobs.size>=maxJobs)return res.status(503).json({error:'The analyser is busy. Please try again shortly.',code:'ANALYSIS_BUSY'});
  const id=crypto.randomUUID(),controller=new AbortController(),j={id,owner:crypto.randomUUID(),startedAt:now(),result:null};let redis=null;
  // Reserve capacity before awaiting Redis, so concurrent submissions cannot bypass maxActive.
  active++;
  try{if(getRedis)redis=await bounded(getRedis);if(redis){await bounded(()=>redis.set(key(id),JSON.stringify(j),{EX:ttlSeconds}));await bounded(()=>redis.set(key(id)+':owner',j.owner,{EX:leaseSeconds}));}}
  catch{active--;return unavailable(res);}
  jobs.set(id,j);res.set('Cache-Control','no-store');res.status(202).json({jobId:id,status:'running',statusUrl:'/api/sportybet/analysis-jobs/'+id});
  let statusCode=200,heartbeat,write=Promise.resolve();const finish=(status,body)=>{if(j.result)return;j.result={status,body};j.finishedAt=now();if(heartbeat)clearInterval(heartbeat);if(redis)write=bounded(()=>redis.set(key(id),JSON.stringify(j),{EX:ttlSeconds})).catch(()=>{});};
  const response={status(n){statusCode=n;return this;},set(){return this;},setHeader(){return this;},json(body){finish(statusCode,body);return this;}};
  if(redis){heartbeat=setInterval(()=>{if(!j.result)void bounded(()=>redis.set(key(id)+':owner',j.owner,{EX:leaseSeconds})).catch(()=>{});},heartbeatMs);heartbeat.unref?.();}
  const timer=setTimeout(()=>{controller.abort();finish(504,{error:'The SportyBet scan took too long. No ticket was booked. Please try a narrower sport or market selection.',code:'ANALYSIS_TIMEOUT'});},timeoutMs);timer.unref?.();
  void Promise.resolve().then(()=>runInScope(()=>handler(req,response),{signal:controller.signal})).then(()=>{if(!j.result)finish(502,{error:'The analyser returned no result. Please retry.',code:'ANALYSIS_NO_RESULT'});}).catch(()=>finish(502,{error:'The analyser could not complete this scan. Please retry.',code:'ANALYSIS_FAILED'})).finally(async()=>{clearTimeout(timer);if(heartbeat)clearInterval(heartbeat);await write;active--;});
 };}
 return {wrap,status};
}
module.exports={createAnalysisJobs};
