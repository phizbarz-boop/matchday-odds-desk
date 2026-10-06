'use strict';
const crypto=require('node:crypto');

function watHourKey(now=new Date()) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Lagos',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const get=type=>parts.find(p=>p.type===type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}`;
}
function quickCashConfig(env=process.env) {
  return {minProbability:0,liveMode:'quick_cash',intervalMinutes:60,
    targetOdds:Math.max(1.05,Math.min(100000,Number(env.TELEGRAM_QC_TARGET_ODDS)||2)),
    maxSelections:Math.max(1,Math.min(40,Number(env.TELEGRAM_QC_MAX_SELECTIONS)||15)),
    flexibleTarget:true};
}

// Scheduled runs share an hourly lock. Each intentional manual run gets an
// independent scope; a repeated request ID still protects ambiguous sends.
function createTelegramQuickCashJob({getRedis,runQuickCash,now=()=>new Date(),logger=console}) {
  return async({runMode='scheduled',requestId='',signal,shouldAbort=()=>false}={})=>{
    const hourKey=watHourKey(now()),dateKey=hourKey.slice(0,10);
    const manual=runMode==='manual';
    requestId=String(requestId).trim();
    if(manual && requestId && !/^[a-zA-Z0-9_-]{1,160}$/.test(requestId)) {
      return {statusCode:400,body:{error:'Invalid manual run ID',code:'TELEGRAM_INVALID_RUN_ID'}};
    }
    runMode=manual?'manual':'scheduled';
    const runKey=manual?'manual:'+crypto.createHash('sha256').update(requestId||crypto.randomUUID()).digest('hex').slice(0,24):hourKey;
    const lockKey=`telegram:quick-cash:once:${runKey}`,statusKey=`telegram:quick-cash:status:${runKey}`;
    let redis,token,acquired=false,posting=false,release;
    const aborted=()=>Boolean(signal?.aborted||shouldAbort());
    const status=async(state,extra={})=>redis.set(statusKey,JSON.stringify({status:state,hourKey,runKey,runMode,at:now().toISOString(),...extra}),{EX:172800});
    const releaseUnsent=(state,detail)=>{
      if(!redis||!acquired||posting)return Promise.resolve();
      if(release)return release;
      release=(async()=>{
        try{await status(state,{detail});}catch(err){logger.error('Quick Cash status write failed:',err.message);}
        await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
          {keys:[lockKey],arguments:[token]});
      })();
      return release;
    };
    const onAbort=()=>{
      void releaseUnsent('cancelled_before_post','Run stopped before Telegram posting').catch(err=>logger.error('Quick Cash unlock failed:',err.message));
    };
    signal?.addEventListener('abort',onAbort,{once:true});
    const cancelledResult=()=>({statusCode:499,body:{error:'Hourly Quick Cash run cancelled',code:'TELEGRAM_CANCELLED_BEFORE_POST'}});
    try {
      if(aborted())return cancelledResult();
      redis=await getRedis();
      if(!redis)return {statusCode:503,body:{error:'REDIS_URL required for hourly Telegram deduplication',code:'TELEGRAM_REDIS_REQUIRED'}};
      token=crypto.randomUUID();
      acquired=(await redis.set(lockKey,token,{NX:true,EX:172800}))==='OK';
      if(!acquired)return {statusCode:200,body:{ok:true,sent:false,skipped:true,reason:manual?'already_processed_this_manual_run':'already_processed_this_hour',hourKey,runKey,runMode}};
      if(aborted()){await releaseUnsent('cancelled_before_post','Run stopped');return cancelledResult();}
      await status('preparing');
      const result=await runQuickCash({redis,hourKey,dateKey,runKey,runMode,shouldAbort:aborted,onPostingStart:async()=>{
        if(aborted()){const err=new Error('Quick Cash run cancelled before posting');err.code='TELEGRAM_CANCELLED_BEFORE_POST';throw err;}
        posting=true;
        await status('posting');
      }});
      if(aborted()&&!posting){await releaseUnsent('cancelled_before_post','Run stopped');return cancelledResult();}
      await status(result.retryable?'partial_or_failed':result.sent?'completed':'no_eligible_games',
        {shareCode:result.shareCode||null,ticketsSent:result.ticketsSent||0});
      // The five-plan runner has its own per-ticket locks, so failed unsent
      // plans may retry without rebuilding a ticket already posted this hour.
      if(result.retryable)await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
        {keys:[lockKey],arguments:[token]});
      return {statusCode:result.retryable?502:200,body:{ok:!result.retryable,hourKey,runKey,runMode,minProbability:0,...result}};
    }catch(err){
      if(redis&&acquired){
        if(!posting)await releaseUnsent(aborted()?'cancelled_before_post':'failed_before_post',String(err.message).slice(0,250)).catch(e=>logger.error('Quick Cash unlock failed:',e.message));
        else await status('partial_or_unknown',{detail:String(err.message).slice(0,250)}).catch(e=>logger.error('Quick Cash status write failed:',e.message));
      }
      logger.error('Telegram hourly Quick Cash failed:',err.message);
      return {statusCode:502,body:{error:'Hourly Quick Cash job failed',detail:String(err.message).slice(0,500)}};
    }finally{
      signal?.removeEventListener('abort',onAbort);
    }
  };
}

// HTTP is only a protected manual/compatibility trigger. The server scheduler
// invokes the same job directly, without a workflow, HTTP call or job secret.
function registerTelegramQuickCashRoute(app,{express,authorize,runJob,...deps}) {
  const job=runJob||createTelegramQuickCashJob(deps);
  app.post('/api/telegram/quick-cash',express.json(),async(req,res)=>{
    if(!authorize(req))return res.status(401).json({error:'unauthorized'});
    const controller=new AbortController();
    res.once('close',()=>{if(!res.writableEnded)controller.abort();});
    const {statusCode,body}=await job({runMode:req.headers['x-matchday-run-mode'],
      requestId:req.headers['x-matchday-run-id']||'',signal:controller.signal});
    if(!res.destroyed)return res.status(statusCode).json(body);
  });
}
module.exports={watHourKey,quickCashConfig,createTelegramQuickCashJob,registerTelegramQuickCashRoute};
