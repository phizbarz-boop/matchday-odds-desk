'use strict';
process.env.SPORTYBET_BOOKING_MODE='public';
process.env.SPORTYBET_PUBLIC_CACHE_ENABLED='false';
process.env.TELEGRAM_NEXT12H_ENABLED='false';
const assert=require('node:assert/strict'),express=require('express');
const {fakeRedis}=require('./fake-redis'),{market,outcome}=require('./sportybet-live-format');
const redis=fakeRedis();require('redis');require.cache[require.resolve('redis')].exports={createClient:()=>redis};
let time=Date.parse('2026-10-08T11:04:00Z'),empty=false,failReads=false,failBooking=false,failSending=false,flip=false;
const RealDate=Date,realInterval=setInterval,realClear=clearInterval,ticks=new Map();
global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}};
global.setInterval=(fn,ms,...args)=>{if(ms!==30000)return realInterval(fn,ms,...args);const marker={unref(){}};ticks.set(marker,fn);return marker;};
global.clearInterval=marker=>{if(ticks.has(marker))ticks.delete(marker);else realClear(marker);};
const messages=[],bookings=[],reads=[],aiMessages=[];let messageAttempts=0,bookingAttempts=0;
const telegram=require('../../lib/telegram');
telegram.sendTelegramMessage=async text=>{messageAttempts++;if(failSending){failSending=false;throw Error('Mock Telegram response lost');}messages.push(text);return [{message_id:messages.length}];};
telegram.sendTelegramAiMessageTo=async(_chat,text)=>aiMessages.push(text);telegram.telegramAiRequest=async()=>({});
const {direct,SPORT_IDS}=require('../../lib/sportybet'),{sportyRequest}=require('../../lib/sportyRequest');
let sessionChecks=0;direct.ensureSession=async()=>{sessionChecks++;assert.fail('Hourly model picks must not load the dummy account');};
const winner=(id,desc,three=false)=>market(id,desc,three?[outcome('1','Home',1.25),outcome('2','Draw',22),outcome('3','Away',22)]:[outcome('4','Home',1.25),outcome('5','Away',8)]);
function event(sport,id,fields={}){return {eventId:`sr:match:hourly-model-${sport}-${id}`,homeTeamName:'Home '+id,awayTeamName:'Away '+id,
  status:1,live:true,estimateStartTime:time-55*60000,matchStatus:'P3',playedSeconds:'55:00',setScore:'3:1',markets:[winner('406','Winner (incl. overtime and penalties)')],...fields};}
function slate(sport){
  if(empty)return [];
  if(sport==='hockey')return [...Array.from({length:34},(_,i)=>event(sport,i)),event(sport,'finished',{live:false,matchStatus:'FT'}),event(sport,'unknown',{setScore:undefined})];
  if(sport==='football')return [event(sport,'late',{matchStatus:'H2',playedSeconds:'80:00',setScore:'2:0',cornerScore:'6:3',markets:[winner('1','1X2',true),market('166','Total Corners Over/Under',[outcome('12','Over 8.5',1.25),outcome('13','Under 8.5',8)],{specifier:'total=8.5'})]}),
    event(sport,'early',{matchStatus:'H1',playedSeconds:'20:00',markets:[winner('1','1X2',true)]}),
    event(sport,'prematch',{live:false,status:0,matchStatus:'Not start',playedSeconds:undefined,markets:[winner('1','1X2',true)]})];
  if(sport==='basketball')return [event(sport,'late',{matchStatus:'Q4',setScore:'80:72',markets:[winner('219','Winner (incl. overtime)')]})];
  if(sport==='handball')return [event(sport,'late',{matchStatus:'H2',setScore:'30:25',markets:[winner('1','1X2',true)]})];
  if(sport==='volleyball')return [event(sport,'late',{matchStatus:'S5',setScore:'2:2',bestOf:5,pointScore:['25:20','20:25','25:20','20:25','12:10'],markets:[winner('186','Winner')]})];
  if(sport==='tennis')return [event(sport,'late',{matchStatus:'S3',setScore:'1:1',bestOf:3,gameScore:['6:4','2:6','4:2'],markets:[winner('186','Winner')]})];
  return [];
}
const response=(data,status=200)=>({ok:status<400,status,headers:{get:k=>k==='content-type'?'application/json':null,getSetCookie:()=>[]},text:async()=>JSON.stringify(data)});
direct.setFetchForTesting(async(url,options)=>{
  const u=new URL(url);reads.push(url);
  for(const key of Object.keys(options.headers))assert.doesNotMatch(key,/^(cookie|authorization|token|accessToken|refreshToken|device-?id)$/i);
  if(u.pathname.endsWith('/orders/share')&&options.method==='POST'){
    assert.notEqual(sportyRequest()?.anonymous,true);bookingAttempts++;const selections=JSON.parse(options.body).selections;
    assert.ok(selections.length>0&&selections.length<=40);assert.ok(selections.every(s=>s.eventId.startsWith('sr:match:hourly-model-')&&!/early|prematch|finished|unknown/.test(s.eventId)));
    if(failBooking){failBooking=false;return response({bizCode:19000,message:'Mock selected outcome suspended'},400);}
    bookings.push(selections);return response({bizCode:10000,data:{shareCode:'HOUR-MODEL-'+bookings.length}});
  }
  assert.match(u.pathname,/\/factsCenter\//);assert.equal(sportyRequest()?.anonymous,true);
  if(failReads)return response({message:'Mock public live source unavailable'},503);
  if(u.searchParams.has('eventId')){
    const id=u.searchParams.get('eventId'),sport=Object.keys(SPORT_IDS).find(s=>id.includes('-'+s+'-'));
    return response({bizCode:10000,data:slate(sport).find(e=>e.eventId===id)||{}});
  }
  assert.match(u.pathname,/liveOrPrematchEvents/,'hourly picks must read only live lists');
  const sport=Object.keys(SPORT_IDS).find(s=>SPORT_IDS[s]===u.searchParams.get('sportId'));
  const events=slate(sport);if(flip)events.forEach(e=>{e.markets.forEach(m=>{if(m.outcomes?.[0])m.outcomes[0].odds='1.8';if(m.outcomes?.[1])m.outcomes[1].odds='1.9';});});
  return response({bizCode:10000,data:{totalNum:events.length,events}});
});
process.on('message',async({id,action,...message})=>{
  if(action==='clock'){time=Date.parse(message.date);for(const tick of ticks.values())tick();}
  if(action==='configure'){if('empty'in message)empty=message.empty;if('failReads'in message)failReads=message.failReads;if('failBooking'in message)failBooking=message.failBooking;if('failSending'in message)failSending=message.failSending;if('flip'in message)flip=message.flip;}
  process.send({id,data:action==='state'?{messages,bookings,reads,aiMessages,messageAttempts,bookingAttempts,sessionChecks,
    data:[...redis.data],hashes:[...redis.hashes].map(([key,rows])=>[key,[...rows]])}:true});
});
const listen=express.application.listen;express.application.listen=function(...args){const server=listen.apply(this,args);server.on('listening',()=>process.send({port:server.address().port}));return server;};
require('../../server');
