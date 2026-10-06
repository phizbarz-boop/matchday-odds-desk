'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hourlyPlans,runHourlyPicks}=require('../lib/telegramHourlyPicks');
const {selectAutoBet}=require('../lib/autoPicker');
const {trackTelegramSlip,updateTrackedTicket,listTrackedSlips}=require('../lib/slipTracker');
const {fakeRedis}=require('./fixtures/fake-redis');
const sportState={Football:{phase:'2nd half',minute:80,homeScore:2,awayScore:0},Basketball:{phase:'4th quarter',homeScore:80,awayScore:72},
  'Ice Hockey':{phase:'3rd period',minute:55,homeScore:3,awayScore:1},Handball:{phase:'2nd half',minute:55,homeScore:30,awayScore:25},
  Volleyball:{phase:'set 5',homeScore:2,awayScore:2,homeSets:2,awaySets:2,bestOf:5,currentHomeGames:12,currentAwayGames:10},
  Tennis:{phase:'set 3',homeScore:1,awayScore:1,homeSets:1,awaySets:1,bestOf:3,currentHomeGames:4,currentAwayGames:2}};
function candidate(sport,probability=92,extra={}) {
  return {sport,live:true,eventId:sport,marketId:'1',outcomeId:'1',marketDesc:'Match Winner',outcomeDesc:'Home',home:'Home',away:'Away',
    probability,odds:1.4,qualityScore:90,edge:0,expectedReturnMultiplier:1,liveState:sportState[sport],...extra};
}
function harness(rows) {
  const redis=fakeRedis(),messages=[],bookings=[],codes=[];let scans=0,failBook=false,failSend=false;
  const deps={redis,env:{},assertSession:async()=>{},loadPool:async()=>{scans++;return {candidates:rows,diagnostics:{}};},
    select:(pool,p)=>selectAutoBet(pool,{targetOdds:p.targetOdds,maxSelections:p.maxSelections,trials:50,rng:()=>.5}),
    validate:async selections=>({valid:selections,dropped:[]}),combine:(selections,targetOdds)=>({selections,targetOdds,combinedOdds:selections.reduce((n,s)=>n*s.odds,1)}),
    book:async selections=>{if(failBook){failBook=false;throw Error('temporary booking failure');}bookings.push(selections);return {shareCode:'CODE'+bookings.length};},
    saveCode:async(_r,_d,h,b,result,plan,run)=>codes.push({h,b,result,plan,run}),track:trackTelegramSlip,updateTrack:updateTrackedTicket,
    send:async text=>{if(failSend){failSend=false;throw Error('ambiguous send');}messages.push(text);}};
  const run=(hourKey='2026-10-06T19',context={})=>runHourlyPicks(deps,{redis,hourKey,dateKey:hourKey.slice(0,10),onPostingStart:async()=>{},shouldAbort:()=>false,...context});
  return {deps,redis,messages,bookings,codes,run,scans:()=>scans,failBook:()=>{failBook=true;},failSend:()=>{failSend=true;}};
}
test('hourly templates are four isolated QC pools at 0% and all-six-sport Live at 85%',()=>{
  const plans=hourlyPlans({});assert.deepEqual(plans.map(p=>p.label),['QC ICE HOCKEY','QC BASKETBALL','QC HANDBALL + VOLLEYBALL','QC FOOTBALL','LIVE ALL SPORTS 85%']);
  assert.deepEqual(plans.map(p=>p.minProbability),[0,0,0,0,85]);assert.equal(plans.at(-1).sports.length,6);
  assert.ok(hourlyPlans({TELEGRAM_QC_MAX_SELECTIONS:'999',TELEGRAM_LIVE_MAX_SELECTIONS:'999'}).every(p=>p.maxSelections<=40));
});
test('one fresh board produces five correctly scoped tickets and preserves independent tracking',async()=>{
  const h=harness(Object.keys(sportState).map(s=>candidate(s)));
  const result=await h.run();assert.equal(result.ticketsSent,5);assert.equal(h.scans(),1);
  assert.equal(h.messages.length,5);assert.equal(h.codes.length,5);
  const tickets=await listTrackedSlips(h.redis);assert.equal(tickets.length,5);assert.ok(tickets.every(t=>t.delivery==='posted'));
  for(const plan of result.plans) {
    const stored=tickets.find(t=>t.ticketId.endsWith(plan.id));
    assert.ok(stored.selections.every(s=>plan.sports.some(p=>s.sport.toLowerCase().includes(p==='hockey'?'hockey':p))));
    assert.ok(stored.selections.every(s=>s.odds>1));assert.equal(stored.minProbability,plan.minProbability);
  }
  assert.ok(h.messages.some(m=>/LIVE ALL SPORTS 85%/.test(m)&&/Minimum probability: 85%/.test(m)));
});
test('QC accepts a qualifying 10-odds selection below 85%, while Live 85% skips it',async()=>{
  const h=harness([candidate('Ice Hockey',9,{odds:10})]);
  const result=await h.run();assert.equal(result.ticketsSent,1);assert.equal(result.results[0].combinedOdds,10);
  assert.equal(result.results.at(-1).reason,'no_eligible_live_games');
});
test('all hourly types exclude early, losing, prematch and unknown-score selections',async()=>{
  const h=harness([candidate('Football',92,{liveState:{...sportState.Football,phase:'1st half',minute:20}}),
    candidate('Basketball',92,{liveState:{...sportState.Basketball,homeScore:60,awayScore:70}}),
    candidate('Handball',92,{live:false}),candidate('Ice Hockey',92,{liveState:{phase:'3rd period'}})]);
  const result=await h.run();assert.equal(result.ticketsSent,0);assert.equal(h.bookings.length,0);
});
test('halfway football is eligible for Live 85% but waits for the late stage in QC',async()=>{
  const h=harness([candidate('Football',90,{liveState:{...sportState.Football,minute:55}})]);
  const result=await h.run();assert.equal(result.ticketsSent,1);assert.equal(result.results.at(-1).sent,true);
  assert.equal(result.results.find(r=>r.id==='qc_football').reason,'no_eligible_live_games');
});
test('currently winning corner and handicap markets can appear in the all-market Live ticket',async()=>{
  const h=harness([candidate('Football',91,{marketId:'166',outcomeId:'12',betType:'corners_over',marketDesc:'Total Corners Over/Under',outcomeDesc:'Over 8.5',specifier:'total=8.5',liveState:{...sportState.Football,homeCorners:6,awayCorners:3}}),
    candidate('Basketball',90,{marketId:'hcp',outcomeId:'1715',betType:'basketball_handicap_away',marketDesc:'Handicap',outcomeDesc:'Away',specifier:'hcp=-10.5'})]);
  const result=await h.run();assert.equal(result.results.at(-1).sent,true);
  const live=h.codes.find(c=>c.plan.id==='live_85');assert.ok(live.result.selections.every(s=>/corners_|handicap/.test(s.betType)));
});
test('sent tickets deduplicate by plan and hour; the next hour produces fresh tickets',async()=>{
  const h=harness([candidate('Football')]);await h.run();const before=h.bookings.length;
  const repeat=await h.run();assert.equal(repeat.ticketsSent,0);assert.equal(h.bookings.length,before);
  await h.run('2026-10-06T20');assert.equal(h.bookings.length,before*2);assert.equal((await listTrackedSlips(h.redis)).length,4);
});
test('one failed booking can retry without re-sending the other successful templates',async()=>{
  const h=harness([candidate('Ice Hockey'),candidate('Basketball')]);h.failBook();
  const first=await h.run();assert.equal(first.retryable,true);assert.equal(first.ticketsSent,2);
  const second=await h.run();assert.equal(second.ticketsSent,1);assert.equal(h.messages.length,3);
});
test('ambiguous delivery is excluded from played stakes and never sent twice',async()=>{
  const h=harness([candidate('Ice Hockey',20)]);h.failSend();const first=await h.run();assert.equal(first.results[0].deliveryUnknown,true);
  const second=await h.run();assert.equal(second.ticketsSent,0);assert.equal(h.bookings.length,1);
  assert.equal((await listTrackedSlips(h.redis))[0].delivery,'unknown');
});
test('a changed selection cannot meet the Live 85% floor merely using its earlier probability',async()=>{
  const h=harness([candidate('Football',90)]);h.deps.validate=async rows=>({valid:rows.map(r=>({...r,probability:50})),dropped:[]});
  const result=await h.run();assert.equal(result.results.at(-1).sent,false);
});

test('all five manual categories can repeat in a scheduled hour with separate codes and 100-naira ticket records',async()=>{
  const h=harness(Object.keys(sportState).map(s=>candidate(s))),hour='2026-10-06T19';
  await h.run(hour);
  const first=await h.run(hour,{runKey:'manual:one',runMode:'manual'});
  const second=await h.run(hour,{runKey:'manual:two',runMode:'manual'});
  assert.equal(first.ticketsSent,5);assert.equal(second.ticketsSent,5);
  assert.equal(h.messages.filter(text=>/MANUAL RUN/.test(text)).length,10);
  assert.equal(h.codes.length,15);
  assert.ok(h.codes.slice(5).every(c=>c.run.runMode==='manual'&&c.h===hour));
  const tickets=await listTrackedSlips(h.redis);
  assert.equal(tickets.length,15);assert.equal(new Set(tickets.map(t=>t.ticketId)).size,15);
  const report=require('../lib/telegramPerformance').buildPerformanceReport(tickets,
    {start:new Date(Date.now()-3600000).toISOString(),end:new Date(Date.now()+3600000).toISOString(),key:'test-manual'});
  assert.equal(report.period.tickets,15);assert.equal(report.period.pendingStake,1500);
});

test('retrying a partially sent manual batch resends only its unsent category',async()=>{
  const h=harness([candidate('Ice Hockey'),candidate('Basketball')]);h.failBook();
  const context={runKey:'manual:partial',runMode:'manual'};
  const first=await h.run(undefined,context);assert.equal(first.ticketsSent,2);assert.equal(first.retryable,true);
  const retry=await h.run(undefined,context);assert.equal(retry.ticketsSent,1);
  assert.equal(h.messages.length,3);assert.equal((await listTrackedSlips(h.redis)).length,3);
});
