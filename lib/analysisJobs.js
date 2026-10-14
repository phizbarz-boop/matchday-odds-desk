'use strict';
const crypto=require('node:crypto');
function createAnalysisJobs({runInScope=fn=>fn(),now=Date.now,maxJobs=100,maxActive=1,timeoutMs=240000,ttlMs=600000}={}){
 const jobs=new Map();let active=0;
 const clean=()=>{for(const [id,j] of jobs)if(j.finishedAt&&now()-j.finishedAt>ttlMs)jobs.delete(id);};
 function status(req,res){clean();const j=jobs.get(String(req.params.id||''));res.set('Cache-Control','no-store');if(!j)return res.status(404).json({error:'The analysis job expired or the server restarted. Start a new analysis.',code:'ANALYSIS_JOB_NOT_FOUND'});if(j.result)return res.status(j.result.status).json(j.result.body);return res.status(202).json({jobId:j.id,status:'running',statusUrl:'/api/sportybet/analysis-jobs/'+j.id});}
 function wrap(handler){return async(req,res)=>{
  if(req.headers['x-plot207-background']!=='1')return handler(req,res);
  clean();if(active>=maxActive||jobs.size>=maxJobs)return res.status(503).json({error:'The analyser is busy. Please try again shortly.',code:'ANALYSIS_BUSY'});
  const id=crypto.randomUUID(),controller=new AbortController(),j={id,result:null};jobs.set(id,j);active++;
  res.set('Cache-Control','no-store');res.status(202).json({jobId:id,status:'running',statusUrl:'/api/sportybet/analysis-jobs/'+id});
  let statusCode=200;const finish=(status,body)=>{if(!j.result){j.result={status,body};j.finishedAt=now();}};
  const response={status(n){statusCode=n;return this;},set(){return this;},setHeader(){return this;},json(body){finish(statusCode,body);return this;}};
  const timer=setTimeout(()=>{controller.abort();finish(504,{error:'The SportyBet scan took too long. No ticket was booked. Please try a narrower sport or market selection.',code:'ANALYSIS_TIMEOUT'});},timeoutMs);timer.unref?.();
  void Promise.resolve().then(()=>runInScope(()=>handler(req,response),{signal:controller.signal})).then(()=>{if(!j.result)finish(502,{error:'The analyser returned no result. Please retry.',code:'ANALYSIS_NO_RESULT'});}).catch(()=>finish(502,{error:'The analyser could not complete this scan. Please retry.',code:'ANALYSIS_FAILED'})).finally(()=>{clearTimeout(timer);active--;});
 };}
 return {wrap,status};
}
module.exports={createAnalysisJobs};
