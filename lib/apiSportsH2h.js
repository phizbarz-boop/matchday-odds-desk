'use strict';
const crypto=require('node:crypto'),{SPORT_HOSTS,sportKey,matchFixture,buildEvidence,canonicalTeam,matchTeam,mappingDiagnostics}=require('./apiSportsH2hData');
const apiError=code=>Object.assign(Error(code),{code});
function createApiH2h({redis,env=process.env,fetchImpl=globalThis.fetch,now=Date.now}={}){
 const key=String(env.APISPORTS_KEY||''),enabled=env.APISPORTS_H2H_ENABLED==='true'&&Boolean(key),account=crypto.createHash('sha256').update(key).digest('hex').slice(0,16),prefix='h2h:api-sports:v1:'+account+':',pending=new Map();
 const budget=(sport,period)=>Math.max(1,Number(env['APISPORTS_H2H_'+period+'_LIMIT_'+sport.toUpperCase()]||env['APISPORTS_H2H_'+period+'_LIMIT'])||(period==='DAILY'?100:10)),local=new Map();
 async function counter(id,ttl){if(redis){const n=await redis.incr(id);if(n===1)await redis.expire(id,ttl);return n;}const n=(local.get(id)||0)+1;local.set(id,n);return n;}
 async function request(sport,path,params={}, {signal,ttl=3600}={}){
  if(!key)throw apiError('API_KEY_MISSING');if(!SPORT_HOSTS[sport]||!/^\/(?:status|teams|fixtures(?:\/headtohead|\/statistics)?|games(?:\/h2h)?)$/.test(path))throw apiError('API_ROUTE_UNSUPPORTED');
  const url=new URL(SPORT_HOSTS[sport]+path);for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
  const cacheKey=prefix+sport+':cache:'+crypto.createHash('sha256').update(url.href).digest('hex');
  if(ttl&&redis){const cached=await redis.get(cacheKey);if(cached){try{return JSON.parse(cached);}catch{}}}
  if(pending.has(cacheKey))return pending.get(cacheKey);
  const job=(async()=>{
   if(path!=='/status'){
    const day=new Date(now()).toISOString().slice(0,10),root=prefix+sport+':';
    if(redis&&await redis.get(root+'blocked:'+day))throw apiError('API_QUOTA_UNAVAILABLE');
    if(redis&&await redis.get(root+'rate-blocked:'+Math.floor(now()/60000)))throw apiError('API_MINUTE_BUDGET');
    if(await counter(root+'minute:'+Math.floor(now()/60000),120)>budget(sport,'MINUTE'))throw apiError('API_MINUTE_BUDGET');
    if(await counter(root+'daily:'+day,172800)>budget(sport,'DAILY'))throw apiError('API_DAILY_BUDGET');
   }
   let response,payload;try{response=await fetchImpl(url.href,{method:'GET',headers:{'x-apisports-key':key},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});const text=await response.text();if(text.length>6000000)throw apiError('API_RESPONSE_TOO_LARGE');payload=JSON.parse(text);}catch(error){throw apiError(error.code==='API_RESPONSE_TOO_LARGE'?error.code:signal?.aborted?'API_CANCELLED':'API_NETWORK_OR_RESPONSE_ERROR');}
   const errors=payload?.errors,hasErrors=errors&&(Array.isArray(errors)?errors.length:Object.keys(errors).length)>0;
   if(!response.ok||hasErrors){const error=require('./apiSportsErrors').providerError(response.status,errors,{sport,path});if(redis&&error.code==='API_DAILY_QUOTA')await redis.set(prefix+sport+':blocked:'+new Date(now()).toISOString().slice(0,10),'1',{EX:86400});if(redis&&error.code==='API_RATE_LIMIT')await redis.set(prefix+sport+':rate-blocked:'+Math.floor(now()/60000),'1',{EX:120});throw error;}
   if(!Array.isArray(payload.response)&&path!=='/status')throw apiError('API_BAD_RESPONSE');
   if(Number(response.headers?.get('x-ratelimit-requests-remaining'))===0&&response.headers?.get('x-ratelimit-requests-remaining')!==null&&redis)await redis.set(prefix+sport+':blocked:'+new Date(now()).toISOString().slice(0,10),'1',{EX:86400});
   if(ttl&&redis)await redis.set(cacheKey,JSON.stringify(payload),{EX:ttl});return payload;
  })();pending.set(cacheKey,job);try{return await job;}finally{pending.delete(cacheKey);}
 }
 async function collect(c,{signal}={}){
  const sport=sportKey(c);if(!SPORT_HOSTS[sport])throw apiError('API_SPORT_UNSUPPORTED');
  const date=new Date(c.kickoffUtc).toISOString().slice(0,10),list=await request(sport,sport==='football'?'/fixtures':'/games',{date,timezone:'UTC'},{signal,ttl:600});
  let matched=matchFixture(list.response,c);const mapping=mappingDiagnostics(list.response,c);
  if(!matched&&sport==='football'){
   try{
    const teams=[];mapping.teamLookups=[];
    for(const label of [c.home,c.away]){const search=canonicalTeam(label,sport);if(search.length<3)throw apiError('API_TEAM_UNMAPPED');const p=await request(sport,'/teams',{search},{signal,ttl:604800});mapping.teamLookups.push({expected:String(label).slice(0,160),returned:p.response.length,candidates:p.response.slice(0,8).map(r=>({id:r.team?.id??null,name:String(r.team?.name||'').slice(0,160),country:String(r.team?.country||'').slice(0,80)}))});const team=matchTeam(p.response,label);if(!team)throw apiError('API_TEAM_UNMAPPED');teams.push(team);}
    if(teams[0].id===teams[1].id)throw apiError('API_TEAM_UNMAPPED');
    matched={teams:{home:teams[0],away:teams[1]},mappingBasis:'verified_team_ids_without_scheduled_fixture'};
   }catch(error){error.mappingDiagnostics=mapping;throw error;}
  }
  if(!matched)throw Object.assign(apiError('API_FIXTURE_UNMAPPED'),{mappingDiagnostics:mapping});
  const pair=[matched.teams.home.id,matched.teams.away.id].join('-'),history=await request(sport,sport==='football'?'/fixtures/headtohead':'/games/h2h',{h2h:pair,...(sport==='football'?{last:10}:{})},{signal,ttl:21600}),statistics=new Map();
  let evidence=buildEvidence(c,matched,history.response,{now:new Date(now())});if(!evidence)throw apiError('API_HISTORY_UNAVAILABLE');
  if(sport==='football')for(const g of evidence.games.slice(0,Math.max(0,Math.min(10,Number(env.APISPORTS_H2H_STATS_LIMIT??5)||0)))){
   try{const p=await request(sport,'/fixtures/statistics',{fixture:g.providerGameId},{signal,ttl:2592000});statistics.set(g.providerGameId,p.response);}catch(error){if(signal?.aborted)throw error;break;}
  }
  if(statistics.size)evidence=buildEvidence(c,matched,history.response,{now:new Date(now()),statistics});return evidence;
 }
 async function status(sport){const p=await request(sport,'/status',{}, {ttl:0});return {sport,plan:p.response?.subscription?.plan||null,active:p.response?.subscription?.active===true,used:p.response?.requests?.current??null,dailyLimit:p.response?.requests?.limit_day??null};}
 return {enabled,collect,status,request};
}
function createCollector({api,fallback,logger=console,now=Date.now}){return async(c,options)=>{
 if(!api.enabled||!sportKey(c))return fallback(c,options);
 try{const evidence=await api.collect(c,{...options,signal:options?.signal?AbortSignal.any([options.signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000)});const needed={football:['goals','corners','cards'],basketball:['points','half_points','quarter_points'],hockey:['goals','period_goals'],handball:['goals','half_goals'],volleyball:['points','sets']}[sportKey(c)]||[];if(needed.some(metric=>!Number.isFinite(evidence.metrics?.[metric]))){try{evidence.sportySupplement=await fallback(c,options);}catch(error){if(options?.signal?.aborted)throw error;}}logger.info?.('[H2H API-Sports] '+JSON.stringify({eventId:c.eventId,sport:c.sport,outcome:'history_ready',samples:evidence.metricSamples}));return evidence;}
 catch(error){if(options?.signal?.aborted)throw error;const code=/^API_[A-Z_]+$/.test(String(error.code||''))?error.code:'API_UNAVAILABLE';logger.warn?.('[H2H API-Sports] '+JSON.stringify({eventId:c.eventId,sport:c.sport,outcome:code,...(error.apiDiagnostics?{details:require('./apiSportsErrors').safeDiagnostics(error)}:{}),fallback:'sportybet'}));return {...await fallback(c,options),apiAttemptedAt:new Date(now()).toISOString(),apiOutcome:code};}
};}
module.exports={createApiH2h,createCollector};
