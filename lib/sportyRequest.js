'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const currentRequest=new AsyncLocalStorage();
const pendingReads=new Map();

function sportyRequest(){return currentRequest.getStore()||null;}
function withFreshSportyRequest(fn){
  if(sportyRequest())return fn();
  return currentRequest.run({startedAt:new Date().toISOString(),reads:new Map()},fn);
}

// A user request always reads SportyBet afresh. Market families share the
// response within that request; overlapping users share only an unfinished
// upstream read, never a completed response from a previous request.
function memoSportyRead(key,read){
  const context=sportyRequest();
  if(!context)return read();
  if(context.reads.has(key))return context.reads.get(key);
  let pending=pendingReads.get(key);
  if(!pending){
    pending=Promise.resolve().then(read);
    pendingReads.set(key,pending);
    pending.finally(()=>{if(pendingReads.get(key)===pending)pendingReads.delete(key);}).catch(()=>{});
  }
  context.reads.set(key,pending);
  return pending;
}
module.exports={sportyRequest,withFreshSportyRequest,memoSportyRead};
