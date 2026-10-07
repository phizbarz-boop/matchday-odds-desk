'use strict';
const {watHourKey}=require('./telegramQuickCash');
const {safeAuthDiagnostics}=require('./sportyAuthDiagnostics');

function hourlySchedulerConfig(env=process.env) {
  const minute=Number(env.TELEGRAM_HOURLY_MINUTE ?? 5);
  const missing=['REDIS_URL','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'].filter(key=>!String(env[key]||'').trim());
  return {enabled:!['false','0','off'].includes(String(env.TELEGRAM_HOURLY_ENABLED ?? 'true').toLowerCase()),
    configured:missing.length===0,missing,minute:Number.isInteger(minute)&&minute>=0&&minute<=59?minute:5,
    timezone:'Africa/Lagos',pollMilliseconds:30000,retryMilliseconds:120000,maxRunMilliseconds:780000};
}

// The application owns this clock. It calls the shared job function, never a
// GitHub workflow or HTTP endpoint. Redis supplies cross-process ticket locks.
function createTelegramHourlyScheduler({runJob,env=process.env,now=()=>new Date(),logger=console,
  timers={setInterval,clearInterval,setTimeout,clearTimeout}}) {
  const config=hourlySchedulerConfig(env);
  let running=false,timer=null,active=null,finishedHour=null,nextAttemptAt=0,lastRun=null;
  const dueAt=date=>Math.floor(date.getTime()/3600000)*3600000+config.minute*60000;
  const status=()=>{
    const date=now(),hourKey=watHourKey(date);
    let nextRunAt=null;
    if(running&&!active) {
      let due=dueAt(date);
      if(finishedHour===hourKey)due+=3600000;
      nextRunAt=new Date(Math.max(date.getTime(),due,nextAttemptAt)).toISOString();
    }
    return {...config,source:'app-server',running,busy:Boolean(active),currentHour:hourKey,
      requiresAlwaysRunningServer:true,nextRunAt,lastRun};
  };
  async function tick() {
    if(!running||active)return false;
    const date=now(),hourKey=watHourKey(date);
    if(date.getTime()<dueAt(date)||finishedHour===hourKey||date.getTime()<nextAttemptAt)return false;
    const controller=new AbortController();
    active=controller;
    lastRun={hourKey,startedAt:date.toISOString(),status:'running'};
    let timedOut=false,deadline;
    const cancelled=new Promise(resolve=>controller.signal.addEventListener('abort',()=>resolve({statusCode:499,
      body:{error:timedOut?'Hourly run exceeded its time limit':'Hourly scheduler stopped'}}),{once:true}));
    deadline=timers.setTimeout(()=>{timedOut=true;controller.abort();},config.maxRunMilliseconds);
    deadline?.unref?.();
    try {
      const result=await Promise.race([cancelled,Promise.resolve().then(()=>runJob({runMode:'scheduled',
        signal:controller.signal,shouldAbort:()=>!running||watHourKey(now())!==hourKey}))]);
      const body=result.body||{},successful=result.statusCode>=200&&result.statusCode<300&&!body.retryable;
      lastRun={hourKey,startedAt:date.toISOString(),finishedAt:now().toISOString(),
        status:successful?'completed':controller.signal.aborted?'stopped':'retry_pending',
        statusCode:result.statusCode,sent:Boolean(body.sent),ticketsSent:body.ticketsSent||0,
        reason:body.reason||null,plans:(body.results||[]).map(plan=>({id:plan.id,sent:Boolean(plan.sent),
          skipped:Boolean(plan.skipped),reason:plan.reason||null,failed:Boolean(plan.error),deliveryUnknown:Boolean(plan.deliveryUnknown)}))};
      if(body.authFailure)lastRun.authFailure=safeAuthDiagnostics({...body.authFailure,diagnostics:body.authFailure});
      if(successful){finishedHour=hourKey;nextAttemptAt=0;}
      else nextAttemptAt=now().getTime()+config.retryMilliseconds;
      // Explain an empty run using fixed outcome codes, never booking errors
      // or credential-bearing upstream responses.
      const outcome=lastRun.reason||lastRun.plans.map(plan=>`${plan.id}=${plan.sent?'sent':plan.deliveryUnknown?'delivery_unknown':plan.failed?'failed':plan.reason||'skipped'}`).join(', ')||'no_result_details';
      logger.log(`[Telegram hourly direct] ${hourKey} ${lastRun.status}; sent=${lastRun.ticketsSent}; outcome=${outcome}`);
    }catch(err){
      lastRun={hourKey,startedAt:date.toISOString(),finishedAt:now().toISOString(),status:'retry_pending',statusCode:502};
      nextAttemptAt=now().getTime()+config.retryMilliseconds;
      logger.error('Telegram hourly scheduler failed:',err.message);
    }finally{
      timers.clearTimeout(deadline);
      active=null;
    }
    return true;
  }
  function start() {
    if(running)return;
    if(!config.enabled||!config.configured) {
      logger.log(`[Telegram hourly direct] disabled: ${config.enabled?'missing '+config.missing.join(', '):'TELEGRAM_HOURLY_ENABLED=false'}`);
      return;
    }
    running=true;
    timer=timers.setInterval(()=>{void tick();},config.pollMilliseconds);
    timer?.unref?.();
    logger.log(`[Telegram hourly direct] active at :${String(config.minute).padStart(2,'0')} each hour WAT; current-hour catch-up enabled`);
    void tick();
  }
  function stop() {
    running=false;
    if(timer!==null)timers.clearInterval(timer);
    timer=null;
    active?.abort();
  }
  return {start,stop,tick,status};
}
module.exports={hourlySchedulerConfig,createTelegramHourlyScheduler};
