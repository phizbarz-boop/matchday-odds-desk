'use strict';
const assert=require('node:assert/strict'),express=require('express');
const {fakeRedis}=require('./fake-redis'),{market,outcome}=require('./sportybet-live-format');
const redis=fakeRedis();require('redis');require.cache[require.resolve('redis')].exports={createClient:()=>redis};
const telegram=require('../../lib/telegram'),messages=[],aiMessages=[],bookings=[],reads=[];
telegram.sendTelegramMessage=async text=>messages.push(text);
telegram.sendTelegramAiMessageTo=async(_chat,text)=>aiMessages.push(text);
telegram.telegramAiRequest=async()=>({});
let time=Date.parse('2026-10-07T05:29:00Z');const RealDate=Date,realInterval=setInterval,realClear=clearInterval,ticks=new Map();
global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}};
global.setInterval=(fn,ms,...args)=>{if(ms!==30000)return realInterval(fn,ms,...args);const marker={unref(){}};ticks.set(marker,fn);return marker;};
global.clearInterval=marker=>{if(ticks.has(marker))ticks.delete(marker);else realClear(marker);};
const {direct,SPORT_IDS}=require('../../lib/sportybet'),{sportyRequest}=require('../../lib/sportyRequest');
let sessionChecks=0;direct.ensureSession=async()=>{assert.notEqual(sportyRequest()?.anonymous,true);sessionChecks++;};direct.startKeepAlive=()=>{};
const sporting={football:['1','1X2'],basketball:['219','Winner (incl. overtime)'],hockey:['1','1X2'],handball:['1','1X2'],volleyball:['186','Winner'],tennis:['186','Winner']};
const events=new Map();
function slate(sport){const [marketId,desc]=sporting[sport],three=['football','hockey','handball'].includes(sport),batch=String(Math.floor(time/3600000));
  return Array.from({length:24},(_,i)=>{
    const eventId=`sr:match:public-api-${sport}-${batch}-${i}`;
    const e={eventId,homeTeamName:'Public Home '+sport+i,awayTeamName:'Public Away '+sport+i,status:0,matchStatus:'Not start',estimateStartTime:time+3*3600000,
      markets:[market(marketId,desc,three?[outcome('1','Home',3),outcome('2','Draw',3),outcome('3','Away',3)]:[outcome('4','Home',3),outcome('5','Away',3)])]};
    events.set(eventId,e);return e;
  });
}
const response=data=>({ok:true,status:200,headers:{get:k=>k==='content-type'?'application/json':null,getSetCookie:()=>[]},text:async()=>JSON.stringify(data)});
direct.setFetchForTesting(async(url,options)=>{
  const u=new URL(url);assert.match(u.pathname,/\/factsCenter\//);assert.equal(sportyRequest()?.anonymous,true);
  assert.ok(!options.headers.Cookie&&!options.headers.Authorization&&!options.headers.token);reads.push(url);
  if(u.searchParams.has('eventId'))return response({bizCode:10000,data:events.get(u.searchParams.get('eventId'))||{}});
  const sport=Object.keys(SPORT_IDS).find(s=>SPORT_IDS[s]===u.searchParams.get('sportId'));
  return response({bizCode:10000,data:{totalNum:24,events:slate(sport)}});
});
direct.createBookingCode=async selections=>{assert.ok(selections.length>0);assert.notEqual(sportyRequest()?.anonymous,true);bookings.push(selections);return {bizCode:10000,data:{shareCode:'PUBLIC-TEST-'+bookings.length}};};
process.on('message',async({id,action,...message})=>{
  if(action==='clock'){time=Date.parse(message.date);for(const tick of ticks.values())tick();}
  if(action==='daily')await redis.set(`telegram:daily-codes:${message.date}`,JSON.stringify({date:message.date,codes:message.codes}));
  process.send({id,data:action==='state'?{messages,aiMessages,bookings,reads,sessionChecks,data:[...redis.data],hashes:[...redis.hashes].map(([key,rows])=>[key,[...rows]])}:true});
});
const listen=express.application.listen;express.application.listen=function(...args){const server=listen.apply(this,args);server.on('listening',()=>process.send({port:server.address().port}));return server;};
require('../../server');
