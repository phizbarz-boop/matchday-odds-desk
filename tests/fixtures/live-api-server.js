'use strict';
process.env.TELEGRAM_HOURLY_MODEL_ENABLED??='false';
// Each fixture enables only the automation it exercises.
process.env.SPORTYBET_PUBLIC_CACHE_ENABLED='false';
process.env.TELEGRAM_NEXT12H_ENABLED='false';
const assert=require('node:assert/strict');
const express=require('express');
const {boards}=require('./sportybet-live-format');
const {direct,SPORT_IDS,extractUpcomingEvents}=require('../../lib/sportybet');
const fixture=boards();
const bySportId=new Map(Object.entries(SPORT_IDS).map(([sport,id])=>[id,fixture[sport]]));
const response=data=>({ok:true,status:200,headers:{get:k=>k==='content-type'?'application/json':null,getSetCookie:()=>[]},text:async()=>JSON.stringify(data)});
direct.setFetchForTesting(async url=>{
  const u=new URL(url);
  assert.ok(u.pathname.includes('/factsCenter/'),'test server must only read sports data');
  const eventId=u.searchParams.get('eventId');
  if(eventId){
    const e=Object.values(fixture).flatMap(p=>extractUpcomingEvents(p).events).find(e=>e.eventId===eventId);
    return response({bizCode:10000,data:e||{}});
  }
  return response(bySportId.get(u.searchParams.get('sportId'))||{bizCode:10000,data:[]});
});
// Stub only the external share-code service. The actual HTTP route, live
// validation, selection IDs and bookBet normalization remain under test.
direct.createBookingCode=async selections=>{
  assert.ok(selections.length>0);
  assert.ok(selections.every(s=>s.eventId.startsWith('sr:match:live-format-')));
  assert.ok(selections.every(s=>!s.eventId.includes('future')&&!s.eventId.includes('finished')));
  return {bizCode:10000,data:{shareCode:'TEST-LIVE-CODE'}};
};
const listen=express.application.listen;
express.application.listen=function(...args){
  const server=listen.apply(this,args);
  server.on('listening',()=>process.send({port:server.address().port}));
  return server;
};
require('../../server');
