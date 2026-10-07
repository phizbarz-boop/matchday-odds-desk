'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createBookingRequests}=require('../lib/sportyBookingRequests');
const {fakeRedis}=require('./fixtures/fake-redis');
const logger={warn(){},error(){}};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const selection={eventId:'fixture',marketId:'1',outcomeId:'1'};
function response(){return {statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(c){this.statusCode=c;return this;},json(body){this.body=body;return this;}};}
function request(requestId,extra={}){return {path:'/api/sportybet/book',headers:{prefer:'respond-async'},body:{requestId,selections:[selection],...extra}};}
async function submit(manager,handler,req){const res=response();await manager.wrap(handler)(req,res);return res;}
async function status(manager,id){const res=response();await manager.status({params:{requestId:id}},res);return res;}
async function completed(manager,id){for(let i=0;i<30;i++){const res=await status(manager,id);if(res.statusCode!==202&&res.body.bookingRequestStatus!=='unknown')return res;await turn();}assert.fail('Booking did not complete');}

test('delayed bookings survive disconnects and repeated submissions return one result',async()=>{
  let clock=0,bookings=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const manager=createBookingRequests({now:()=>clock,logger}),id=randomUUID();
  const handler=async(req,res)=>{bookings++;res.bookingStage('creating_code');await gate;return res.json({shareCode:'ONE-CODE',telegramSendToken:'one-send-token'});};
  const first=await submit(manager,handler,request(id));assert.equal(first.statusCode,202);await turn();
  clock=24000;const waiting=await status(manager,id);assert.equal(waiting.statusCode,202);assert.equal(waiting.body.stage,'creating_code');
  const retries=await Promise.all(Array.from({length:10},()=>submit(manager,handler,request(id))));
  assert.ok(retries.every(r=>r.statusCode===202));assert.equal(bookings,1);
  release();const done=await completed(manager,id);assert.equal(done.body.shareCode,'ONE-CODE');assert.equal(done.body.telegramSendToken,'one-send-token');
  const repeat=await submit(manager,handler,request(id));assert.equal(repeat.body.shareCode,'ONE-CODE');assert.equal(bookings,1);
  assert.equal(done.headers['Cache-Control'],'no-store');
});
test('a request ID cannot be reused for a different slip or booking route',async()=>{
  const manager=createBookingRequests({logger}),id=randomUUID();let bookings=0;
  const handler=async(req,res)=>{bookings++;res.json({shareCode:'CODE'});};
  await submit(manager,handler,request(id));await completed(manager,id);
  for(const req of [request(id,{selections:[{...selection,outcomeId:'2'}]}),{...request(id),path:'/api/sportybet/live/book'}]){
    const conflict=await submit(manager,handler,req);assert.equal(conflict.statusCode,409);assert.equal(conflict.body.bookingErrorCode,'BOOKING_REQUEST_CONFLICT');
  }
  assert.equal(bookings,1);
});
test('Redis shares one pending booking between server instances and retains its completed code after restart',async()=>{
  const redis=fakeRedis(),options={getRedis:async()=>redis,logger};
  const first=createBookingRequests(options),second=createBookingRequests(options),id=randomUUID();
  let bookings=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const handler=async(req,res)=>{bookings++;await gate;res.json({shareCode:'PERSISTED'});};
  const results=await Promise.all([submit(first,handler,request(id)),submit(second,handler,request(id))]);
  assert.ok(results.every(r=>r.statusCode===202));await turn();assert.equal(bookings,1);
  release();await completed(first,id);await turn();
  assert.equal((await completed(second,id)).body.shareCode,'PERSISTED');
  const restarted=createBookingRequests(options);assert.equal((await submit(restarted,handler,request(id))).body.shareCode,'PERSISTED');
  assert.equal(bookings,1);
});
test('an old pending booking or a missing record never starts another provider submission',async()=>{
  let clock=0,bookings=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const manager=createBookingRequests({now:()=>clock,logger}),id=randomUUID();
  const handler=async(req,res)=>{bookings++;await gate;res.json({shareCode:'LATE'});};
  await submit(manager,handler,request(id));await turn();clock=600001;
  const late=await submit(manager,handler,request(id));assert.equal(late.statusCode,409);assert.equal(late.body.bookingOutcomeUnknown,true);
  const missing=await status(manager,randomUUID());assert.equal(missing.statusCode,404);assert.equal(missing.body.bookingOutcomeUnknown,true);
  assert.equal(bookings,1);release();assert.equal((await completed(manager,id)).body.shareCode,'LATE');
});
test('a failed authentication result is retained without a second login attempt',async()=>{
  const manager=createBookingRequests({logger}),id=randomUUID();let logins=0;
  const handler=async(req,res)=>{logins++;res.status(503).json({bookingErrorCode:'SPORTYBET_AUTH_FAILED',authFailure:{reason:'browser_page_timeout'}});};
  await submit(manager,handler,request(id));const failed=await completed(manager,id);
  assert.equal(failed.statusCode,503);assert.equal(failed.body.authFailure.reason,'browser_page_timeout');
  await submit(manager,handler,request(id));assert.equal(logins,1);
});
test('status storage failures preserve uncertainty and malformed requests never book',async()=>{
  const manager=createBookingRequests({getRedis:async()=>{throw Error('private connection details');},logger});let calls=0;
  const handler=async(req,res)=>{calls++;res.json({shareCode:'UNEXPECTED'});};
  const rejected=await submit(manager,handler,request(randomUUID()));assert.equal(rejected.statusCode,503);assert.equal(calls,0);
  const missing=await status(manager,randomUUID());assert.equal(missing.statusCode,503);assert.equal(missing.body.bookingOutcomeUnknown,true);
  assert.doesNotMatch(JSON.stringify(missing.body),/private connection details/);
  assert.equal((await submit(manager,handler,request('bad-id'))).statusCode,400);
  assert.equal((await submit(manager,handler,request(randomUUID(),{selections:[]}))).statusCode,400);assert.equal(calls,0);
});
test('a known code remains available when persisting its final result fails',async()=>{
  const redis=fakeRedis(),set=redis.set;
  redis.set=async(...args)=>{if(!args[2]?.NX)throw Error('storage failed after booking');return set(...args);};
  const manager=createBookingRequests({getRedis:async()=>redis,logger}),id=randomUUID();
  await submit(manager,async(req,res)=>res.json({shareCode:'KEEP-CODE'}),request(id));
  assert.equal((await completed(manager,id)).body.shareCode,'KEEP-CODE');
});
test('unexpected worker failure retains an unknown outcome without leaking its raw error',async()=>{
  const manager=createBookingRequests({logger}),id=randomUUID();let calls=0;
  const handler=async()=>{calls++;throw Error('raw-private-error');};
  await submit(manager,handler,request(id));const result=await completed(manager,id);
  assert.equal(result.statusCode,502);assert.equal(result.body.bookingOutcomeUnknown,true);assert.doesNotMatch(JSON.stringify(result.body),/raw-private/);
  await submit(manager,handler,request(id));assert.equal(calls,1);
});
test('existing synchronous API callers retain their response contract',async()=>{
  const manager=createBookingRequests({logger});const req={headers:{},body:{selections:[selection]}};
  const result=await submit(manager,async(req,res)=>res.json({shareCode:'SYNC'}),req);
  assert.equal(result.statusCode,200);assert.deepEqual(result.body,{shareCode:'SYNC'});
});
