'use strict';
const crypto=require('node:crypto');
const REQUEST_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

// A short HTTP submission starts one booking. Status reads only retrieve its
// result, so losing the browser connection cannot submit the slip twice.
function createBookingRequests({getRedis=async()=>null,runInScope=fn=>fn(),now=Date.now,
  ttlSeconds=86400,pendingTimeoutMs=600000,storageTimeoutMs=5000,maxEntries=1000,logger=console}={}) {
  const memory=new Map();
  const key=id=>'sportybet:booking-request:'+id;
  const bounded=async fn=>{
    let timer;
    try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error('Booking request storage unavailable')),storageTimeoutMs);
    })]);}finally{clearTimeout(timer);}
  };
  const storage=()=>bounded(getRedis);
  const clean=()=>{for(const [id,value] of memory)if(value.expiresAt<=now())memory.delete(id);};
  async function read(id,redis) {
    clean();
    if(memory.has(id))return memory.get(id);
    if(!redis)return null;
    const raw=await bounded(()=>redis.get(key(id)));
    if(!raw)return null;
    const value=JSON.parse(raw);
    return value.expiresAt>now()?value:null;
  }
  function reply(value,res) {
    res.set('Cache-Control','no-store');
    if(value.result)return res.status(value.result.statusCode).json({...value.result.body,
      requestId:value.requestId,bookingRequestStatus:value.result.statusCode<400?'completed':'failed'});
    if(now()-value.startedAt>pendingTimeoutMs)return res.status(409).json({
      error:'This booking has not finished. Check its status again to retrieve the original result.',
      requestId:value.requestId,bookingRequestStatus:'unknown',bookingOutcomeUnknown:true});
    return res.status(202).json({requestId:value.requestId,bookingRequestStatus:'pending',stage:value.stage,
      statusUrl:'/api/sportybet/book/status/'+value.requestId,checkAfterMilliseconds:1500});
  }
  function storageFailure(res,existing=false) {
    return res.status(503).json({error:existing?'Booking status is temporarily unavailable. Check the same request again.'
      :'Booking request storage is temporarily unavailable. No new booking was started.',
      bookingErrorCode:'BOOKING_STORAGE_UNAVAILABLE',...(existing?{bookingOutcomeUnknown:true}:{})});
  }
  async function finish(value,redis,result) {
    value.result=result;value.finishedAt=now();
    if(redis)try{await bounded(()=>redis.set(key(value.requestId),JSON.stringify(value),{EX:ttlSeconds}));}
    catch{logger.warn('[SportyBet booking] Result retained in this server; persistent storage unavailable');}
  }
  function launch(value,redis,handler,req) {
    // No response-close abort: a provider may already have accepted the share.
    void Promise.resolve().then(()=>runInScope(async()=>{
      let statusCode=200,body;
      const response={status(code){statusCode=code;return this;},json(value){body=value;return this;},
        set(){return this;},bookingStage(stage){value.stage=stage;}};
      try{
        await handler(req,response);
        if(body===undefined)throw Error('Booking handler returned no result');
        await finish(value,redis,{statusCode,body});
      }catch{
        logger.error('[SportyBet booking] Request failed without a confirmed result');
        await finish(value,redis,{statusCode:502,body:{error:'SportyBet has not confirmed this booking. Check this request again before starting another.',
          bookingErrorCode:'BOOKING_RESULT_UNKNOWN',bookingOutcomeUnknown:true}});
      }
    })).catch(()=>logger.error('[SportyBet booking] Could not retain the request result'));
  }
  function wrap(handler) {
    return async(req,res)=>{
      if(String(req.headers.prefer||'').toLowerCase()!=='respond-async')return handler(req,res);
      const requestId=String(req.body?.requestId||'');
      if(!REQUEST_ID.test(requestId))return res.status(400).json({error:'A valid booking request ID is required'});
      const selections=req.body?.selections;
      if(!Array.isArray(selections)||!selections.length||selections.length>100||selections.some(s=>!s?.eventId||!s?.marketId||!s?.outcomeId))
        return res.status(400).json({error:'Provide 1-100 selections with eventId, marketId and outcomeId'});
      const {requestId:ignored,...payload}=req.body;
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify({route:req.path,payload})).digest('hex');
      clean();let redis,current=memory.get(requestId);
      if(!current)try{redis=await storage();current=await read(requestId,redis);}catch{return storageFailure(res);}
      if(!current) {
        clean();
        if(memory.size>=maxEntries)return res.status(503).json({error:'Booking queue is busy. Try again shortly.'});
        const value={requestId,fingerprint,startedAt:now(),expiresAt:now()+ttlSeconds*1000,stage:'preparing'};
        if(redis) {
          let claimed;
          try{claimed=await bounded(()=>redis.set(key(requestId),JSON.stringify(value),{NX:true,EX:ttlSeconds}));}
          catch{return storageFailure(res);}
          if(claimed!=='OK') {
            try{current=await read(requestId,redis);}catch{return storageFailure(res);}
            if(!current)return storageFailure(res);
          }
        }
        // Local callers can race across awaits even when Redis is absent.
        current=current||memory.get(requestId);
        if(!current){memory.set(requestId,value);current=value;launch(value,redis,handler,req);}
      }
      if(current.fingerprint!==fingerprint)return res.status(409).json({error:'This booking request ID belongs to a different slip.',
        bookingErrorCode:'BOOKING_REQUEST_CONFLICT'});
      return reply(current,res);
    };
  }
  async function status(req,res) {
    const id=String(req.params.requestId||'');
    if(!REQUEST_ID.test(id))return res.status(400).json({error:'Invalid booking request ID'});
    clean();let value=memory.get(id);
    if(!value)try{value=await read(id,await storage());}catch{return storageFailure(res,true);}
    if(!value)return res.status(404).json({error:'Booking request not found. Its outcome could not be confirmed.',
      bookingRequestStatus:'missing',bookingOutcomeUnknown:true});
    return reply(value,res);
  }
  return {wrap,status};
}
module.exports={createBookingRequests};
