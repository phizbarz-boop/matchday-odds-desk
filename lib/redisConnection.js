'use strict';
// Share the readiness promise, not a client whose TLS/auth handshake is pending.
function createRedisConnection({createClient,url=()=>process.env.REDIS_URL,logger=console,timeoutMs=5000,now=Date.now}={}){
 let client=null,opening=null,lastLog=-Infinity;
 function report(error){if(now()-lastLog<30000)return;lastLog=now();const code=/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|REDIS_CONNECT_TIMEOUT|REDIS_NOT_READY)$/.test(error?.code)?error.code:'REDIS_CONNECTION_UNAVAILABLE';logger.error?.('[Redis connection] '+code+'; check Redis availability and the REDIS_URL setting.');}
 async function get(){const endpoint=url();if(!endpoint)return null;if(client?.isReady)return client;if(opening)return opening;
  const current=client||createClient({url:endpoint,disableOfflineQueue:true,socket:{connectTimeout:timeoutMs,reconnectStrategy:attempt=>attempt>=3?false:Math.min(1000,200*2**attempt)}});client=current;
  if(!current.__plot207ErrorListener){current.on('error',report);current.__plot207ErrorListener=true;}
  let timer,ready,ended;
  const job=(async()=>{try{
   const wait=current.isOpen?new Promise((resolve,reject)=>{ready=resolve;ended=()=>reject(Object.assign(Error('Redis not ready'),{code:'REDIS_NOT_READY'}));current.once('ready',ready);current.once('end',ended);if(current.isReady)resolve();}):current.connect();
   await Promise.race([wait,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Redis connection timed out'),{code:'REDIS_CONNECT_TIMEOUT'})),timeoutMs);})]);
   if(!current.isReady)throw Object.assign(Error('Redis not ready'),{code:'REDIS_NOT_READY'});return current;
  }catch(error){if(client===current)client=null;try{if(current.isOpen)await current.disconnect();}catch{}report(error);throw error;}
  finally{clearTimeout(timer);if(ready)current.removeListener('ready',ready);if(ended)current.removeListener('end',ended);}})();
  opening=job;try{return await job;}finally{if(opening===job)opening=null;}
 }
 return {get};
}
module.exports={createRedisConnection};
