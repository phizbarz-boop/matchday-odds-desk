'use strict';
const assert=require('node:assert/strict'),express=require('express');
const {fakeRedis}=require('./fake-redis');
const redis=fakeRedis();
require('redis');require.cache[require.resolve('redis')].exports={createClient:()=>redis};
const telegram=require('../../lib/telegram');
const messages=[],aiMessages=[],bookings=[];
let aiWait;
telegram.sendTelegramMessage=async text=>{messages.push(text);return [{message_id:messages.length}];};
telegram.sendTelegramAiMessageTo=async(_chat,text)=>{aiMessages.push(text);if(aiWait){aiWait();aiWait=null;}return [{message_id:aiMessages.length}];};
telegram.telegramAiRequest=async()=>({});
const {boards,market,outcome,event}=require('./sportybet-live-format');
// Only this isolated test process substitutes the wall clock and timer, so
// integration tests can cross an hour without waiting or sending real bets.
let testClock=process.env.TEST_HOURLY_CLOCK?Date.parse(process.env.TEST_HOURLY_CLOCK):null,schedulerTick;
if(testClock!==null) {
  const RealDate=Date,realSetInterval=setInterval,realClearInterval=clearInterval,marker={unref(){}};
  global.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[testClock]));}static now(){return testClock;}};
  global.setInterval=(fn,ms,...args)=>{if(ms!==30000)return realSetInterval(fn,ms,...args);schedulerTick=fn;return marker;};
  global.clearInterval=handle=>{if(handle===marker)schedulerTick=null;else realClearInterval(handle);};
}
function handballBoard() {
  return {bizCode:10000,data:[{id:'sr:tournament:handball-manual',name:'Handball Live League',events:[
    event('sr:match:live-format-handball',{playedSeconds:'55:30',remainingTimeInPeriod:'04:30',setScore:'30:25',markets:[
      market('1','1X2',[outcome('1','Home',1.05),outcome('2','Draw',12),outcome('3','Away',26)])]}),
  ]}]};
}
const {direct,SPORT_IDS,extractUpcomingEvents}=require('../../lib/sportybet');
// This child process substitutes the authenticated dummy session only in tests.
let sessionChecks=0,settled=false;
direct.ensureSession=async()=>{sessionChecks++;};
let fixture=boards(),liveReads=0,flip=false,flipOdds=false,empty=false,footballOnly=false,tennisOnly=false;
if(process.env.TEST_HOURLY_ALL_SPORTS==='true')fixture.handball=handballBoard();
const response=data=>({ok:true,status:200,headers:{get:k=>k==='content-type'?'application/json':null,getSetCookie:()=>[]},text:async()=>JSON.stringify(data)});
direct.setFetchForTesting(async url=>{
  const u=new URL(url);
  if(u.pathname.includes('/orders/share')) {
    const code=u.searchParams.get('shareCode'),index=Number(code?.split('-').at(-1))-1;
    const selections=bookings[index]||[];
    return response({bizCode:10000,data:{outcomes:selections.map(s=>({...s,
      ...(settled?{settlementStatus:index===1?'LOST':index===2?'VOID':'WON'}:{})}))}});
  }
  assert.ok(u.pathname.includes('/factsCenter/'));
  const eventId=u.searchParams.get('eventId');
  if(eventId)return response({bizCode:10000,data:Object.values(fixture).flatMap(p=>extractUpcomingEvents(p).events).find(e=>e.eventId===eventId)||{}});
  const sport=Object.keys(SPORT_IDS).find(s=>SPORT_IDS[s]===u.searchParams.get('sportId'));
  if(sport==='football'&&++liveReads>1&&flip){
    fixture.football.data.forEach(t=>t.events.forEach(e=>{e.setScore='0:2';e.cornerScore='1:1';}));
  }
  if(sport==='football'&&liveReads>1&&flipOdds)fixture.football.data.forEach(t=>t.events.forEach(e=>{
    e.markets.filter(m=>m.id==='1').forEach(m=>{m.outcomes[0].odds='3';m.outcomes[1].odds='2.7';m.outcomes[2].odds='1.8';});
  }));
  if(empty||footballOnly&&sport!=='football'||tennisOnly&&sport!=='tennis')return response({bizCode:10000,data:[]});
  const board=JSON.parse(JSON.stringify(fixture[sport]||{bizCode:10000,data:[]}));
  if(tennisOnly)board.data.forEach(t=>t.events.forEach(e=>{e.markets=e.markets.filter(m=>m.desc!=='Correct Score');}));
  return response(board);
});
direct.createBookingCode=async selections=>{
  assert.ok(selections.length>0&&selections.every(s=>s.eventId.startsWith('sr:match:live-format-')));
  bookings.push(selections);return {bizCode:10000,data:{shareCode:'QC-TEST-'+bookings.length}};
};
process.on('message',async message=>{
  const {id,action}=message;
  if(action==='clock'&&testClock!==null){testClock=Date.parse(message.date);schedulerTick?.();}
  if(action==='state')return process.send({id,data:{messages,aiMessages,bookings,sessionChecks,data:[...redis.data],hashes:[...redis.hashes].map(([key,rows])=>[key,[...rows]])}});
  if(action==='report_configuration') {
    settled=!!message.settled;
    const window=require('../../lib/telegramPerformance').reportWindow(new Date());
    for(const [key,rows] of redis.hashes)if(key==='telegram:tracked-tickets:v2')for(const [field,raw] of rows) {
      const ticket=JSON.parse(raw);ticket.createdAt=ticket.postedAt=new Date(new Date(window.start).getTime()+3600000).toISOString();
      rows.set(field,JSON.stringify(ticket));
    }
  }
  if(action==='configure'){
    fixture=boards();liveReads=0;flip=!!message.flip;flipOdds=!!message.flipOdds;empty=!!message.empty;footballOnly=!!message.footballOnly;tennisOnly=!!message.tennisOnly;
    if(message.handballEligible)fixture.handball=handballBoard();
    if(tennisOnly){
      const e=fixture.tennis.data[0].events[0];e.gameScore=['6:4','4:6','4:2'];
      e.markets.push(market('test-match-score','Correct Score',['2:0','2:1','0:2','1:2'].map((score,i)=>outcome('score-'+i,score,2))));
    }
    if(message.early)for(const sport of ['football','basketball','hockey'])fixture[sport].data.forEach(t=>t.events.forEach(e=>{e.matchStatus=sport==='basketball'?'Q1':'H1';e.playedSeconds='10:00';}));
    for(const key of [...redis.data.keys()])if(key.startsWith('telegram:quick-cash:once:')||key.startsWith('telegram:hourly-pick:once:'))redis.data.delete(key);
    redis.hashes.delete('telegram:tracked-tickets:v2');
  }
  if(action==='daily')redis.data.set(`telegram:daily-codes:${message.date}`,JSON.stringify({date:message.date,codes:message.codes}));
  if(action==='await_ai'){
    if(aiMessages.length>message.after)return process.send({id,data:true});
    return new Promise(resolve=>{const timer=setTimeout(()=>{aiWait=null;process.send({id,data:false});resolve();},3000);aiWait=()=>{clearTimeout(timer);process.send({id,data:true});resolve();};});
  }
  process.send({id,data:true});
});
const listen=express.application.listen;
express.application.listen=function(...args){const server=listen.apply(this,args);server.on('listening',()=>process.send({port:server.address().port}));return server;};
require('../../server');
