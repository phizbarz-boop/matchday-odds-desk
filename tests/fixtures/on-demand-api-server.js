'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const express=require('express');
const {direct,SPORT_IDS}=require('../../lib/sportybet');
const {boards,market,outcome}=require('./sportybet-live-format');
const {sportyRequest}=require('../../lib/sportyRequest');
const state={version:1,homeOdds:1.10,suspendTotals:false,empty:false,listEmpty:false,fail:false,reads:0};
const live=boards();
const byId=new Map(Object.entries(SPORT_IDS).map(([sport,id])=>[id,sport]));
const root=path.join(__dirname,'../..');
const predictionFile=path.join(root,'data/predictions.json');
const snapshotDir=path.join(root,'data/sporty-snapshots');
const oldPrediction={eventId:'sr:match:old-only',sportyEventId:'sr:match:old-only',modelVersion:'sportybet-football-v1',goalModelAvailable:true,
  home:'Home football',away:'Away football',league:'Old League',kickoffUtc:new Date(Date.now()+3600000).toISOString(),h:99,d:0.5,a:0.5,o15:99,goalLambdaHome:3,goalLambdaAway:0.1};
const staleSnapshot={fetchedAt:new Date().toISOString(),snapshotSavedAt:new Date().toISOString(),snapshotHours:504,rows:[
  {sport:'Football',eventId:oldPrediction.eventId,home:oldPrediction.home,away:oldPrediction.away,tournament:'Old League',kickoffUtc:oldPrediction.kickoffUtc,marketId:'1',marketDesc:'1X2',outcomeId:'1',outcomeDesc:'Home',odds:4},
]};
// Seed earlier daily data in this child only. Never write to the user's data.
const exists=fs.existsSync,read=fs.readFileSync;
fs.existsSync=function(p){return String(p)===predictionFile||String(p).startsWith(snapshotDir+path.sep)||exists.apply(this,arguments);};
fs.readFileSync=function(p,encoding){
  const value=String(p)===predictionFile?{generatedAt:'2026-01-01T00:00:00.000Z',matches:[oldPrediction]}
    :String(p).startsWith(snapshotDir+path.sep)?staleSnapshot:null;
  if(value){const text=JSON.stringify(value);return encoding?text:Buffer.from(text);}
  return read.apply(this,arguments);
};
function currentEvent(sport){
  const winner=sport==='football'||sport==='handball'
    ?market('1','1X2',[outcome('1','Home',state.homeOdds),outcome('2','Draw',9),outcome('3','Away',26)])
    :market(sport==='basketball'?'219':sport==='hockey'?'406':'186','Winner (incl. overtime)',[outcome('4','Home',1.15),outcome('5','Away',5.5)]);
  return {eventId:`sr:match:on-demand-${sport}-${state.version}`,homeTeamName:'Home '+sport,awayTeamName:'Away '+sport,
    estimateStartTime:Date.now()+4*3600000,status:0,matchStatus:'Not start',markets:[winner,
      market(sport==='tennis'?'189':sport==='volleyball'?'238':'18',sport==='tennis'?'Total games 19.5':sport==='volleyball'?'Total points':'Over/Under',
        [outcome('12','Over '+(sport==='tennis'?'19.5':'1.5'),1.18),outcome('13','Under '+(sport==='tennis'?'19.5':'1.5'),4.5)],
        {specifier:sport==='tennis'?'total=19.5':'total=1.5',status:state.suspendTotals?1:0}),
      market('19','Home Total Goals - Over/Under',[outcome('12','Over 0.5',1.20),outcome('13','Under 0.5',4.8)],{specifier:'total=0.5'}),
      ...(sport==='volleyball'?[market('900450','Total Sets',[outcome('12','Over 3.5',1.3),outcome('13','Under 3.5',3.4)],{specifier:'total=3.5'})]:[]),
    ]};
}
const response=data=>({ok:true,status:200,headers:{get:k=>k==='content-type'?'application/json':null,getSetCookie:()=>[]},text:async()=>JSON.stringify(data)});
direct.setFetchForTesting(async url=>{
  const u=new URL(url);
  assert.ok(u.pathname.includes('/factsCenter/'),'fixture must only read sports data');
  state.reads++;
  if(state.fail)throw new Error('Fixture SportyBet source unavailable');
  if(u.pathname.endsWith('/liveOrPrematchEvents'))return response(live[byId.get(u.searchParams.get('sportId'))]||{bizCode:10000,data:[]});
  const eventId=u.searchParams.get('eventId');
  if(eventId){
    assert.ok(u.searchParams.get('_t'),'current event details must bypass earlier HTTP responses');
    const sport=Object.keys(SPORT_IDS).find(s=>eventId.includes('on-demand-'+s+'-'));
    return response({bizCode:10000,data:state.empty||!sport?{}:currentEvent(sport)});
  }
  const sport=byId.get(u.searchParams.get('sportId'));
  assert.ok(u.searchParams.get('_t'),'current reads must bypass completed upstream HTTP caches');
  if(['tennis','volleyball','handball'].includes(sport))assert.ok(u.searchParams.get('marketId'),'SportyBet requires an embedded-market hint');
  return response({bizCode:10000,data:state.empty||state.listEmpty||!sport?[]:[{id:'sr:tournament:current',name:'Current '+sport+' League',events:[currentEvent(sport)]}]});
});
direct.lookupBooking=async(_code,options)=>{
  assert.ok(sportyRequest(),'code analysis retains the current request context');
  assert.equal(options.fresh,true,'submitted codes are decoded with a current lookup');
  return {bizCode:10000,data:{selections:[{
  sport:'Football',eventId:currentEvent('football').eventId,homeTeamName:'Home football',awayTeamName:'Away football',
  marketId:'18',marketDesc:'Over/Under',outcomeId:'12',outcomeDesc:'Over 1.5',specifier:'total=1.5',odds:1.18,
}]}};
};
const listen=express.application.listen;
express.application.listen=function(...args){const server=listen.apply(this,args);server.on('listening',()=>process.send({port:server.address().port}));return server;};
process.on('message',m=>{if(m.type==='state'){Object.assign(state,m.change||{});process.send({id:m.id,state:{...state}});}});
require('../../server');
