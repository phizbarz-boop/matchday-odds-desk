'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createBookingClient}=require('../public/booking-client');
const payload={selections:[{eventId:'fixture',marketId:'1',outcomeId:'1'}],telegramContext:[]};
const result=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>body});
function harness(fetch,extra={}){
  let clock=0;const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const options={fetch,storage,crypto:{randomUUID},now:()=>clock,wait:async ms=>{clock+=ms;},...extra};
  return {client:createBookingClient(options),options,values,now:()=>clock};
}
test('a booking taking more than 18 seconds submits once and retrieves its code through status reads',async()=>{
  let posts=0,reads=0;const h=harness(async(url,options)=>{
    if(options.method==='POST'){posts++;assert.equal(options.headers.Prefer,'respond-async');return result(202,{bookingRequestStatus:'pending'});}
    reads++;return h.now()<24000?result(202,{stage:'creating_code'}):result(200,{shareCode:'DELAYED',telegramSendToken:'SEND'});
  });
  const booked=await h.client.book(payload);assert.equal(booked.shareCode,'DELAYED');assert.equal(booked.telegramSendToken,'SEND');
  assert.equal(posts,1);assert.ok(reads>12);assert.ok(h.now()>=24000);assert.equal(h.values.size,0);
});
test('losing the first HTTP response only polls the accepted booking without resubmitting',async()=>{
  let posts=0,reads=0;const h=harness(async(url,options)=>{
    if(options.method==='POST'){posts++;throw Object.assign(Error('lost response'),{name:'AbortError'});}
    reads++;return result(200,{shareCode:'RECOVERED'});
  });
  assert.equal((await h.client.book(payload)).shareCode,'RECOVERED');assert.equal(posts,1);assert.equal(reads,1);
});
test('a later click and page reload resume the original pending request ID',async()=>{
  let posts=0,ids=[],ready=false;const h=harness(async(url,options)=>{
    if(options.method==='POST'){posts++;ids.push(JSON.parse(options.body).requestId);return result(202,{});}
    ids.push(url.split('/').at(-1));return ready?result(200,{shareCode:'RESUMED'}):result(202,{});
  },{maxWaitMs:3000});
  await assert.rejects(h.client.book(payload),/still processing/);assert.equal(h.values.size,1);
  ready=true;const reloaded=createBookingClient(h.options);
  assert.equal((await reloaded.book(payload)).shareCode,'RESUMED');assert.equal(posts,1);assert.equal(new Set(ids).size,1);assert.equal(h.values.size,0);
});
test('an uncertain provider timeout is retained so retry checks status instead of booking again',async()=>{
  let posts=0,reads=0;const h=harness(async(url,options)=>{
    if(options.method==='POST')posts++;else reads++;
    return result(504,{error:'Provider response timed out',bookingOutcomeUnknown:true});
  });
  for(let i=0;i<2;i++)await assert.rejects(h.client.book(payload),e=>e.bookingOutcomeUnknown===true);
  assert.equal(posts,1);assert.equal(reads,1);assert.equal(h.values.size,1);
});
test('a definite sign-in failure permits a new request after the account is corrected',async()=>{
  const ids=[];let valid=false;const h=harness(async(url,options)=>{
    ids.push(JSON.parse(options.body).requestId);
    return valid?result(200,{shareCode:'NOW-READY'}):result(503,{authFailure:{reason:'verification_required'}});
  });
  await assert.rejects(h.client.book(payload),/verification_required/);assert.equal(h.values.size,0);
  valid=true;assert.equal((await h.client.book(payload)).shareCode,'NOW-READY');assert.equal(new Set(ids).size,2);
});
test('overlapping button clicks share one booking and another slip waits',async()=>{
  let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});
  const h=harness(async()=>{calls++;await gate;return result(200,{shareCode:'ONE'});});
  const first=h.client.book(payload),second=h.client.book(payload);assert.equal(first,second);
  await assert.rejects(h.client.book({...payload,selections:[]}),/current booking/);release();
  assert.equal((await first).shareCode,'ONE');assert.equal(calls,1);
});
test('status-store failures keep the original request for recovery',async()=>{
  let posts=0,offline=true;const h=harness(async(url,options)=>{
    if(options.method==='POST'){posts++;return result(202,{});}
    return offline?result(503,{error:'Status unavailable',bookingOutcomeUnknown:true}):result(200,{shareCode:'RESTORED'});
  });
  await assert.rejects(h.client.book(payload),/Status unavailable/);assert.equal(h.values.size,1);
  offline=false;assert.equal((await h.client.book(payload)).shareCode,'RESTORED');assert.equal(posts,1);
});
