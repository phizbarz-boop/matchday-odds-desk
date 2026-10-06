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

// Hourly runs have their own shared lock. A retry after an ambiguous Telegram
// send must not publish twice; a failure/cancellation before sending may retry.
function registerTelegramQuickCashRoute(app,{express,authorize,getRedis,runQuickCash,now=()=>new Date(),logger=console}) {
  app.post('/api/telegram/quick-cash',express.json(),async(req,res)=>{
    if(!authorize(req))return res.status(401).json({error:'unauthorized'});
    const hourKey=watHourKey(now()),dateKey=hourKey.slice(0,10);
    const lockKey=`telegram:quick-cash:once:${hourKey}`,statusKey=`telegram:quick-cash:status:${hourKey}`;
    let redis,token,acquired=false,posting=false,cancelled=false,release;
    const status=async(state,extra={})=>redis.set(statusKey,JSON.stringify({status:state,hourKey,at:now().toISOString(),...extra}),{EX:172800});
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
    res.once('close',()=>{
      if(res.writableEnded||posting)return;
      cancelled=true;
      void releaseUnsent('cancelled_before_post','Workflow disconnected before Telegram posting').catch(err=>logger.error('Quick Cash unlock failed:',err.message));
    });
    try {
      redis=await getRedis();
      if(!redis)return res.status(503).json({error:'REDIS_URL required for hourly Telegram deduplication',code:'TELEGRAM_REDIS_REQUIRED'});
      token=crypto.randomUUID();
      acquired=(await redis.set(lockKey,token,{NX:true,EX:172800}))==='OK';
      if(!acquired)return res.json({ok:true,sent:false,skipped:true,reason:'already_processed_this_hour',hourKey});
      if(cancelled){await releaseUnsent('cancelled_before_post','Workflow disconnected');return;}
      await status('preparing');
      const result=await runQuickCash({redis,hourKey,dateKey,shouldAbort:()=>cancelled,onPostingStart:async()=>{
        if(cancelled){const err=new Error('Quick Cash run cancelled before posting');err.code='TELEGRAM_CANCELLED_BEFORE_POST';throw err;}
        posting=true;
        await status('posting');
      }});
      if(cancelled&&!posting){await releaseUnsent('cancelled_before_post','Workflow disconnected');return;}
      await status(result.sent?'completed':'no_eligible_games',{shareCode:result.shareCode||null});
      if(!res.destroyed)return res.json({ok:true,hourKey,minProbability:0,...result});
    }catch(err){
      if(redis&&acquired){
        if(!posting)await releaseUnsent(cancelled?'cancelled_before_post':'failed_before_post',String(err.message).slice(0,250)).catch(e=>logger.error('Quick Cash unlock failed:',e.message));
        else await status('partial_or_unknown',{detail:String(err.message).slice(0,250)}).catch(e=>logger.error('Quick Cash status write failed:',e.message));
      }
      logger.error('Telegram hourly Quick Cash failed:',err.message);
      if(!res.destroyed)return res.status(502).json({error:'Hourly Quick Cash job failed',detail:String(err.message).slice(0,500)});
    }
  });
}
module.exports={watHourKey,quickCashConfig,registerTelegramQuickCashRoute};
