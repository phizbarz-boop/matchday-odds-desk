process.env.TELEGRAM_THREE_HOURLY_ENABLED='false';
'use strict';
process.env.TELEGRAM_HOURLY_MODEL_ENABLED??='false';
const assert=require('node:assert/strict'),express=require('express');
const {fakeRedis}=require('./fake-redis'),{market,outcome}=require('./sportybet-live-format');
const redis=fakeRedis();require('redis');require.cache[require.resolve('redis')].exports={createClient:()=>redis};
process.env.SPORTYBET_BOOKING_MODE='public';
const mode=process.env.TELEGRAM_PICKS_TEST_MODE;
const RealDate=Date,time=Date.parse('2026-10-07T08:00:00Z');
global.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}};
const messages=[],bookings=[],reads=[];let messageAttempts=0,releaseRead;
const readGate=new Promise(resolve=>{releaseRead=resolve;});
const telegram=require('../../lib/telegram');
telegram.sendTelegramMessage=async text=>{messageAttempts++;if(mode==='send-failure'&&messageAttempts===2)throw Object.assign(Error('Telegram sendMessage failed: Forbidden: bot was blocked by the user'),{status:403});messages.push(text);};
const {direct,SPORT_IDS}=require('../../lib/sportybet');
direct.ensureSession=async()=>assert.fail('Telegram picks must not load the dummy session');
const events=new Map();
const sporting={football:['1','1X2'],basketball:['219','Winner (incl. overtime)'],hockey:['1','1X2'],handball:['1','1X2'],volleyball:['186','Winner'],tennis:['186','Winner']};
for(const sport of Object.keys(sporting)) {
  const [id,desc]=sporting[sport],three=['football','hockey','handball'].includes(sport);
  for(let i=0;i<6;i++) {
    const eventId=`sr:match:telegram-safe-${sport}-${i}`;
    const e={eventId,homeTeamName:`Safe Home ${sport} ${i}`,awayTeamName:`Safe Away ${sport} ${i}`,status:0,matchStatus:'Not start',
      estimateStartTime:time+3*3600000,markets:[market(id,desc,three?
        [outcome('1','Home',1.08),outcome('2','Draw',22),outcome('3','Away',22)]:[outcome('4','Home',1.08),outcome('5','Away',15)])]};
    events.set(eventId,e);
  }
}
const response=(data,status=200)=>({ok:status<400,status,headers:{get:key=>key==='content-type'?'application/json':null,getSetCookie:()=>[]},text:async()=>JSON.stringify(data)});
direct.setFetchForTesting(async(url,options)=>{
  const u=new URL(url);reads.push(url);
  assert.ok(!options.headers.Cookie&&!options.headers.Authorization&&!options.headers.token);
  if(u.pathname.endsWith('/orders/share')&&options.method==='POST') {
    const selections=JSON.parse(options.body).selections;bookings.push(selections);
    if(mode==='booking-failure')return response({bizCode:19000,message:'The selected SportyBet outcome was suspended'},400);
    assert.ok(selections.length>0&&selections.every(s=>s.eventId&&s.marketId&&s.outcomeId));
    return response({bizCode:10000,data:{shareCode:'SAFE-API-'+bookings.length}});
  }
  assert.match(u.pathname,/\/factsCenter\//);
  if(mode==='source-failure')return response({message:'Mock SportyBet public feed unavailable'},503);
  if(mode==='delayed')await readGate;
  if(u.searchParams.has('eventId'))return response({bizCode:10000,data:events.get(u.searchParams.get('eventId'))||{}});
  const sport=Object.keys(SPORT_IDS).find(key=>SPORT_IDS[key]===u.searchParams.get('sportId'));
  const slate=mode==='empty'?[]:[...events.values()].filter(e=>e.eventId.includes(`-${sport}-`));
  return response({bizCode:10000,data:{totalNum:slate.length,events:slate}});
});
redis.data.set('telegram:daily-codes:2026-10-07',JSON.stringify({date:'2026-10-07',codes:[{targetOdds:'1.30–5.00 SAFE',combinedOdds:1.5,shareCode:'PREVIOUS-SAFE'}]}));
process.on('message',({id,action})=>{
  if(action==='release')releaseRead();
  process.send({id,data:{messages,bookings,reads,messageAttempts,storedCodes:{codes:[...JSON.parse(redis.data.get('telegram:daily-codes:2026-10-07')||'{"codes":[]}').codes,...[...(redis.hashes.get('telegram:all-codes:2026-10-07')?.values()||[])].map(row=>JSON.parse(row))]}}});
});
const listen=express.application.listen;express.application.listen=function(...args){const server=listen.apply(this,args);server.on('listening',()=>process.send({port:server.address().port}));return server;};
require('../../server');
