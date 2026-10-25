'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const currentRequest=new AsyncLocalStorage();
const pendingReads=new Map();
const {BoundedMemoryCache,retainedBytes}=require('./boundedMemoryCache');
const requestStore=extra=>({startedAt:new Date().toISOString(),reads:new BoundedMemoryCache({maxBytes:24*1024*1024,maxEntries:96}),pending:new Map(),...extra});

function sportyRequest(){return currentRequest.getStore()||null;}
function withFreshSportyRequest(fn,{reset=false}={}){
  if(sportyRequest()&&!reset)return fn();
  return currentRequest.run(requestStore(),fn);
}
function withPublicSportyRequest(fn,{signal}={}){
  return currentRequest.run(requestStore({anonymous:true,signal}),fn);
}

// A user request always reads SportyBet afresh. Market families share the
// response within that request; overlapping users share only an unfinished
// upstream read, never a completed response from a previous request.
function memoSportyRead(key,read){
  const context=sportyRequest();
  if(!context)return read();
  key=`${context.anonymous?'anonymous':'session'}|${key}`;
  const hit=context.reads.get(key);if(hit)return hit;
  if(context.pending.has(key))return context.pending.get(key);
  let pending=pendingReads.get(key);
  if(!pending){
    pending=Promise.resolve().then(read);
    pendingReads.set(key,pending);
    pending.finally(()=>{if(pendingReads.get(key)===pending)pendingReads.delete(key);}).catch(()=>{});
  }
  context.pending.set(key,pending);
  pending.then(payload=>{context.reads.set(key,pending,retainedBytes(payload,context.reads.maxBytes));},()=>{}).finally(()=>context.pending.delete(key)).catch(()=>{});
  return pending;
}
module.exports={sportyRequest,withFreshSportyRequest,withPublicSportyRequest,memoSportyRead};
