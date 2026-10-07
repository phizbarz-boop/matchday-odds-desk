'use strict';
const crypto=require('node:crypto');
function watParts(date=new Date()){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Lagos',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const get=k=>p.find(x=>x.type===k).value;
  return {date:`${get('year')}-${get('month')}-${get('day')}`,minute:Number(get('hour'))*60+Number(get('minute'))};
}
function createWatScheduler({name,times,runJob,enabled=true,configured=true,catchupMinutes=Infinity,
  maxRunMilliseconds=1800000,now=()=>new Date(),logger=console,timers={setInterval,clearInterval,setTimeout,clearTimeout}}){
  const minutes=times.map(t=>{if(!/^\d{2}:\d{2}$/.test(t))throw new Error('Invalid WAT schedule time');const [h,m]=t.split(':').map(Number);if(h>23||m>59)throw new Error('Invalid WAT schedule time');return h*60+m;});
  if(minutes.some((m,i)=>i>0&&m<=minutes[i-1]))throw new Error('WAT schedule times must be increasing');
  let running=false,timer=null,active=null,completed=new Set(),nextAttemptAt=0,lastRun=null;
  const due=()=>{const p=watParts(now()),index=minutes.findLastIndex(m=>m<=p.minute);return index<0||p.minute-minutes[index]>catchupMinutes?null:{slotKey:p.date+'T'+times[index],dateKey:p.date,slotTime:times[index]};};
  async function tick(){
    const slot=due();if(!running||active||!slot||completed.has(slot.slotKey)||now().getTime()<nextAttemptAt)return false;
    const controller=new AbortController();active=controller;lastRun={...slot,status:'running',startedAt:now().toISOString()};
    const deadline=timers.setTimeout(()=>controller.abort(),maxRunMilliseconds);deadline?.unref?.();
    try{
      // Abort limits the work itself; do not permit a timed-out worker to run
      // alongside a retry and post after its original slot has ended.
      const result=await runJob({...slot,signal:controller.signal,shouldAbort:()=>!running||controller.signal.aborted||due()?.slotKey!==slot.slotKey});
      const success=result.statusCode>=200&&result.statusCode<300&&!result.body?.retryable;
      lastRun={...lastRun,status:success?'completed':'retry_pending',finishedAt:now().toISOString(),ticketsSent:result.body?.ticketsSent||0,reason:result.body?.reason||result.body?.error||null};
      if(result.body?.results)lastRun.results=result.body.results.map(r=>({id:r.id,sent:Boolean(r.sent),reason:r.reason||r.error||null}));
      if(success){completed.add(slot.slotKey);completed=new Set([...completed].filter(key=>key.startsWith(slot.dateKey)));nextAttemptAt=0;}
      else nextAttemptAt=now().getTime()+120000;
      logger.log(`[${name}] ${slot.slotKey} ${lastRun.status}; tickets=${lastRun.ticketsSent}`);
    }catch(err){lastRun={...lastRun,status:'retry_pending',finishedAt:now().toISOString(),reason:String(err.message).slice(0,180)};nextAttemptAt=now().getTime()+120000;logger.error(`[${name}]`,err.message);}
    finally{timers.clearTimeout(deadline);active=null;}return true;
  }
  function start(){if(running||!enabled||!configured)return;running=true;timer=timers.setInterval(()=>{void tick();},30000);timer?.unref?.();logger.log(`[${name}] active ${times.join(', ')} WAT`);void tick();}
  function stop(){running=false;if(timer!==null)timers.clearInterval(timer);timer=null;active?.abort();}
  function status(){return {source:'app-server',timezone:'Africa/Lagos',times,enabled,configured,running,busy:Boolean(active),lastRun,requiresAlwaysRunningServer:true};}
  return {start,stop,tick,status};
}

function createWatSlotJob({namespace,getRedis,run,timers={setInterval,clearInterval}}){
  return async({slotKey,dateKey,slotTime,signal,shouldAbort=()=>false})=>{
    const lock=`${namespace}:once:${slotKey}`,done=`${namespace}:done:${slotKey}`,token=crypto.randomUUID();
    let redis,acquired=false,heartbeat;
    try{
      redis=await getRedis();
      if(redis){
        if(await redis.get(done))return {statusCode:200,body:{skipped:true,reason:'already_processed_this_slot'}};
        acquired=await redis.set(lock,token,{NX:true,EX:900})==='OK';
        if(!acquired)return {statusCode:503,body:{retryable:true,reason:'slot_in_progress'}};
        // Running locks expire after a stopped process. Completed slots and
        // per-ticket checkpoints survive a restart for two days.
        heartbeat=timers.setInterval(()=>{void redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], 900) else return 0 end',{keys:[lock],arguments:[token]}).catch(()=>{});},45000);
        heartbeat?.unref?.();
      }
      const result=await run({slotKey,dateKey,slotTime,redis,signal,shouldAbort:()=>Boolean(signal?.aborted||shouldAbort())});
      if(!result.retryable&&redis)await redis.set(done,JSON.stringify({completedAt:new Date().toISOString()}),{EX:172800});
      return {statusCode:result.retryable?502:200,body:result};
    }catch(err){return {statusCode:502,body:{retryable:true,error:String(err.message).slice(0,200)}};}
    finally{if(heartbeat)timers.clearInterval(heartbeat);if(acquired)await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',{keys:[lock],arguments:[token]}).catch(()=>{});}
  };
}
module.exports={watParts,createWatScheduler,createWatSlotJob};
