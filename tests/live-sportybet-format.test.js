'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {boards,market,outcome,event}=require('./fixtures/sportybet-live-format');
const {extractUpcomingEvents,flattenDetailedMarkets,getLiveSportMarket,validateLiveSelections,direct,SPORT_IDS}=require('../lib/sportybet');
const {parseClock,liveState,ongoing,lateStage,winningSideSelection}=require('../lib/liveModel');
const {buildCandidates}=require('../lib/autoPicker');
const response=data=>({ok:true,status:200,headers:{get:k=>k==='content-type'?'application/json':null,getSetCookie:()=>[]},text:async()=>JSON.stringify(data)});

test('live tournament arrays include every competition with inherited league names',()=>{
  const {events}=extractUpcomingEvents(boards().football);
  assert.equal(events.length,5);
  assert.equal(events[0].tournament_name,'Live League A');
  assert.equal(events[2].tournament_name,'Live League B');
  assert.equal(events[2].category,'Country B');
  const nested={data:{sports:[{categories:[{id:'sr:category:1',name:'Country',tournaments:[{name:'One',events:[event('sr:match:1')]},{name:'Two',events:[event('sr:match:2')]}]}]}]}};
  assert.deepEqual(extractUpcomingEvents(nested).events.map(e=>e.tournament_name),['One','Two']);
  assert.equal(extractUpcomingEvents({data:{events:[event('sr:match:1'),event('sr:match:1')]}}).events.length,1);
});

test('SportyBet phase codes, setScore and mm:ss clocks identify current play',()=>{
  const s=liveState(event('sr:match:test'));
  assert.equal(s.homeScore,2);assert.equal(s.awayScore,0);
  assert.equal(s.minute,63.95);assert.match(s.phase,/2nd half/);
  for(const phase of ['H1','H2','HT','Q1','Q4','P3','OT','set 3'])assert.equal(ongoing({matchStatus:phase}),true,phase);
  for(const phase of ['Not start','Not started','FT','Finished'])assert.equal(ongoing(event('sr:match:test',{live:true,matchStatus:phase})),false,phase);
  assert.equal(parseClock(4800,{seconds:true}),80);
  assert.equal(parseClock('80:30',{seconds:true}),80.5);
  assert.equal(parseClock('90+2'),92);
  assert.equal(parseClock(''),null);assert.equal(parseClock('63:99'),null);
});

test('numeric market status and inactive outcomes exclude unavailable selections',()=>{
  const e=event('sr:match:test',{markets:[
    market('1','1X2',[outcome('1','Home',1.5),outcome('2','Draw',4,0),outcome('3','Away',6)]),
    market('18','Over/Under',[outcome('12','Over 1.5',1.5)],{status:3}),
    market('10','Double Chance',[outcome('10','Home or Draw',1.1)],{status:1}),
    market('99','Winner',[outcome('4','Home',null),{id:'5',desc:'Away',odds:''}]),
  ]});
  assert.deepEqual(flattenDetailedMarkets(e,{live:true}).map(r=>r.marketId+'/'+r.outcomeId),['1/1','1/3']);
});

test('live Auto candidates and booking validation consume tournament envelopes',async()=>{
  const fixture=boards();
  direct.setFetchForTesting(async url=>{
    const u=new URL(url);
    if(u.searchParams.has('eventId'))return response(extractUpcomingEvents(fixture.football).events.find(e=>e.eventId===u.searchParams.get('eventId'))||{});
    assert.equal(u.searchParams.get('sportId'),SPORT_IDS.football);
    return response(fixture.football);
  });
  try{
    const winner=await getLiveSportMarket('football','1x2',{maxPages:1});
    assert.equal(winner.rows.length,9);
    assert.deepEqual(winner.feedDiagnostics,{sourceEvents:5,ongoingEvents:3,excludedEvents:2});
    assert.ok(winner.rows.every(r=>r.marketId==='1'&&r.live));
    const candidates=buildCandidates({predictions:{matches:[]},footballMarkets:{'1x2':winner},sportScope:'football',betTypes:['home_win'],minProbability:80,minEdge:0});
    assert.equal(candidates.length,2);
    assert.ok(candidates.every(c=>c.live&&c.probability>=80&&c.probability<100));
    const corners=await getLiveSportMarket('football','corners',{maxPages:1});
    assert.equal(corners.rows.length,2);
    assert.equal(buildCandidates({predictions:{matches:[]},footballMarkets:{corners},betTypes:['corners_over'],minProbability:75,minEdge:0}).length,1);
    const selections=[{...candidates.find(c=>c.eventId==='sr:match:live-format-late'),quickCash:true},
      {sport:'football',eventId:'sr:match:live-format-finished',marketId:'1',outcomeId:'1'},
      {sport:'football',eventId:'sr:match:live-format-1',marketId:'18',outcomeId:'12',specifier:'total=1.5'}];
    const validated=await validateLiveSelections(selections,{maxPages:1});
    assert.equal(validated.valid.length,1);assert.equal(validated.dropped.length,2);
    fixture.football.data[1].events[0].setScore='2:3';
    assert.equal((await validateLiveSelections([selections[0]],{maxPages:1})).valid.length,0,'fresh leader changes invalidate Quick Cash');
  }finally{direct.setFetchForTesting(null);}
});

test('live hockey matches the offered full-match winner ID without period winners',async()=>{
  direct.setFetchForTesting(async()=>response(boards().hockey));
  try{
    const payload=await getLiveSportMarket('hockey','winner',{maxPages:1});
    assert.equal(payload.rows.length,2);assert.ok(payload.rows.every(r=>r.marketId==='406'));
    const candidates=buildCandidates({hockeyWinner:payload,sportScope:'hockey',betTypes:['hockey_winner'],minProbability:80});
    assert.equal(candidates.length,1);assert.equal(winningSideSelection(candidates[0]),true);
  }finally{direct.setFetchForTesting(null);}
});

test('Q4 Quick Cash reads the actual cumulative score and excludes tied games',()=>{
  const events=extractUpcomingEvents(boards().basketball).events;
  const q4=flattenDetailedMarkets(events[0],{live:true,sport:'Basketball'}).find(r=>r.marketId==='219');
  assert.equal(lateStage(q4),true);assert.equal(winningSideSelection({...q4,betType:'basketball_winner'}),true);
  assert.equal(winningSideSelection({...q4,liveState:liveState(events[1])}),false);
  const incomplete=flattenDetailedMarkets(events[1],{live:true,sport:'Basketball'});
  assert.equal(buildCandidates({basketballWinner:{rows:incomplete},sportScope:'basketball',minProbability:0}).length,0,'one inactive side cannot become a 100% estimate');
});

test('concurrent live market families share one current SportyBet board read',async()=>{
  let calls=0;
  direct.setFetchForTesting(async()=>{calls++;await new Promise(resolve=>setImmediate(resolve));return response(boards().basketball);});
  try{
    const [winner,all]=await Promise.all([getLiveSportMarket('basketball','winner',{maxPages:1}),getLiveSportMarket('basketball','all',{maxPages:1})]);
    assert.ok(winner.rows.length>0&&all.rows.length>winner.rows.length);
    assert.equal(calls,1,'selecting many bet types must not send duplicate concurrent board requests');
  }finally{direct.setFetchForTesting(null);}
});
