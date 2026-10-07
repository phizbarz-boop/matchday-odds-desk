'use strict';
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const RUN_ID=/^[a-zA-Z0-9_-]{1,160}$/;

// A workflow submits once and reads the same result through short requests.
// Redis claims survive disconnects and restarts; an unfinished claim is never
// restarted automatically because Telegram delivery may already have happened.
function createTelegramRunRequests({name,authorize,getRedis,runInScope=fn=>fn(),
  env=process.env,now=Date.now,storageTimeoutMs=5000,pendingTimeoutMs=2100000,
  ttlSeconds=172800,maxEntries=500,logger=console}) {
  const memory=new Map(),prefix=`telegram:run-request:${name}:`;
  const statusBase=`/api/telegram/${name}/run-status/`;
  const clean=()=>{for(const [id,value] of memory)if(value.expiresAt<=now())memory.delete(id);};
  async function bounded(fn) {
    let timer;
    try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error('Telegram run storage unavailable')),storageTimeoutMs);
    })]);}finally{clearTimeout(timer);}
  }
  async function read(id,redis) {
    clean();if(memory.has(id))return memory.get(id);
    const raw=await bounded(()=>redis.get(prefix+id));
    if(!raw)return null;
    const value=JSON.parse(raw);return value.expiresAt>now()?value:null;
  }
  function reply(value,res) {
    res.set('Cache-Control','no-store');
    if(value.result)return res.status(value.result.statusCode).json({...value.result.body,
      runId:value.runId,runRequestStatus:value.result.statusCode<400?'completed':'failed',stage:value.stage});
    if(now()-value.startedAt>pendingTimeoutMs)return res.status(409).json({ok:false,
      error:'This Telegram run has no confirmed final result. Check the same run again; it has not been restarted.',
      code:'TELEGRAM_RUN_OUTCOME_UNKNOWN',runId:value.runId,runRequestStatus:'unknown',stage:value.stage});
    return res.status(202).json({ok:true,runId:value.runId,runRequestStatus:'pending',stage:value.stage,
      statusUrl:statusBase+value.runId,checkAfterMilliseconds:3000});
  }
  function unavailable(res) {
    return res.status(503).json({ok:false,error:'Telegram run storage is temporarily unavailable. Check the same run ID before submitting another.',
      code:'TELEGRAM_RUN_STORAGE_UNAVAILABLE'});
  }
  async function persist(value,redis) {
    try{await bounded(()=>redis.set(prefix+value.runId,JSON.stringify(value),{EX:ttlSeconds}));}
    catch{logger.warn('[Telegram run] Status retained locally; persistent storage unavailable');}
  }
  function launch(value,redis,handler,req) {
    void Promise.resolve().then(()=>runInScope(async()=>{
      const response=new EventEmitter();
      let statusCode=200,body;
      Object.assign(response,{destroyed:false,writableEnded:false,
        status(code){statusCode=code;return this;},set(){return this;},
        json(data){body=data;this.writableEnded=true;this.emit('close');return this;},
        async jobStage(stage){value.stage=stage;await persist(value,redis);}});
      try {
        await handler(req,response);
        if(body===undefined)throw Error('Telegram handler returned no confirmed result');
      }catch {
        statusCode=502;body={ok:false,error:'Telegram run ended without a confirmed result. Do not resubmit it under a new ID.',
          code:'TELEGRAM_RUN_OUTCOME_UNKNOWN'};
      }
      value.result={statusCode,body};value.finishedAt=now();
      await persist(value,redis);
      logger.log(`[Telegram run] ${name} ${value.runId}; status=${statusCode}; stage=${value.stage}`);
    })).catch(()=>logger.error('[Telegram run] Could not retain the final result'));
  }
  function wrap(handler) {
    return async(req,res)=>{
      if(!authorize(req))return res.status(401).json({error:'unauthorized'});
      if(String(req.headers.prefer||'').trim().toLowerCase()!=='respond-async')return handler(req,res);
      const id=String(req.headers['x-matchday-run-id']||'').trim();
      if(!RUN_ID.test(id))return res.status(400).json({error:'A valid x-matchday-run-id is required',code:'TELEGRAM_RUN_ID_REQUIRED'});
      const missing=['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'].filter(key=>!env[key]);
      if(missing.length)return res.status(503).json({error:'Telegram integration is not configured on the app server',
        code:'TELEGRAM_CONFIG_MISSING',missingSettings:missing});
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify({mode:req.headers['x-matchday-run-mode']||'scheduled',body:req.body||{}})).digest('hex');
      clean();let redis,current=memory.get(id);
      if(!current)try{redis=await bounded(getRedis);if(!redis)return res.status(503).json({error:'REDIS_URL is required for Telegram run state',code:'TELEGRAM_REDIS_REQUIRED'});
        current=await read(id,redis);}catch{return unavailable(res);}
      if(!current) {
        if(memory.size>=maxEntries)return res.status(503).json({error:'Telegram run queue is busy',code:'TELEGRAM_RUN_QUEUE_BUSY'});
        const value={runId:id,fingerprint,startedAt:now(),expiresAt:now()+ttlSeconds*1000,stage:'queued'};
        let claimed;
        try{claimed=await bounded(()=>redis.set(prefix+id,JSON.stringify(value),{NX:true,EX:ttlSeconds}));}catch{return unavailable(res);}
        if(claimed!=='OK')try{current=await read(id,redis);}catch{return unavailable(res);}
        if(claimed!=='OK'&&!current)return unavailable(res);
        current=current||memory.get(id);
        if(!current){memory.set(id,value);current=value;launch(value,redis,handler,req);}
      }
      if(current.fingerprint!==fingerprint)return res.status(409).json({error:'This Telegram run ID belongs to a different request.',code:'TELEGRAM_RUN_CONFLICT',runId:id});
      return reply(current,res);
    };
  }
  async function status(req,res) {
    if(!authorize(req))return res.status(401).json({error:'unauthorized'});
    const id=String(req.params.runId||'');
    if(!RUN_ID.test(id))return res.status(400).json({error:'Invalid Telegram run ID'});
    let value;
    try{const redis=await bounded(getRedis);if(!redis)return unavailable(res);value=await read(id,redis);}catch{return unavailable(res);}
    if(!value)return res.status(404).json({error:'Telegram run not found; no final outcome is confirmed.',code:'TELEGRAM_RUN_NOT_FOUND',runId:id});
    return reply(value,res);
  }
  return {wrap,status};
}
module.exports={createTelegramRunRequests};
