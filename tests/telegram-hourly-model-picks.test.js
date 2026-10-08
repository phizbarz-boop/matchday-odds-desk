'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hourlyModelPlans,runHourlyModelPicks,STATE_PREFIX,hourlyTicketText}=require('../lib/telegramHourlyModelPicks');
const {trackTelegramSlip,updateTrackedTicket,listTrackedSlips}=require('../lib/slipTracker');
const {fakeRedis}=require('./fixtures/fake-redis');
const clock=new Date('2026-10-08T11:05:00Z');
const row=(id,extra={})=>({sport:'Ice Hockey',live:true,eventId:'live-'+id,marketId:'406',outcomeId:'4',betType:'hockey_winner',
  home:'Home '+id,away:'Away '+id,marketDesc:'Winner (incl. overtime and penalties)',outcomeDesc:'Home',odds:1.25,probability:90,
  liveState:{phase:'3rd period',minute:55,homeScore:3,awayScore:1},...extra});
function harness({rows=Array.from({length:34},(_,i)=>row(i)),...overrides}={}){
  const redis=fakeRedis(),messages=[],bookings=[],codes=[];let scans=0,validations=0;
  const deps={now:()=>clock,env:{},loadPool:async()=>{scans++;return {candidates:rows,diagnostics:{}};},
    validate:async selections=>{validations++;return {valid:selections};},assertBookingReady:async()=>{},
    book:async selections=>{bookings.push(selections);return {shareCode:'MODEL-'+bookings.length};},
    saveCode:async(_r,_d,key,plan,booking,result)=>codes.push({key,plan,booking,result}),
    track:trackTelegramSlip,updateTrack:updateTrackedTicket,send:async text=>messages.push(text),...overrides};
  const context={redis,slotKey:'2026-10-08T12',hourKey:'2026-10-08T12',slotTime:'12:05',dateKey:'2026-10-08',shouldAbort:()=>false};
  const run=(change={})=>runHourlyModelPicks(deps,{...context,...change});
  return {deps,redis,messages,bookings,codes,context,run,scans:()=>scans,validations:()=>validations};
}

test('the requested hourly batch contains exactly Live 3, QC 3 and Live 1000 across all six sports',()=>{
  const plans=hourlyModelPlans({});assert.deepEqual(plans.map(p=>p.targetOdds),[3,3,1000]);assert.deepEqual(plans.map(p=>p.liveMode),['live','quick_cash','live']);
  assert.deepEqual(plans.map(p=>p.minProbability),[0,0,0]);assert.ok(plans.every(p=>p.maxSelections===40&&p.sports.length===6));
  assert.deepEqual(hourlyModelPlans({TELEGRAM_QC_TARGET_ODDS:2,TELEGRAM_LIVE_TARGET_ODDS:2}).map(p=>p.targetOdds),[3,3,1000]);
  assert.ok(hourlyModelPlans({TELEGRAM_HOURLY_MAX_SELECTIONS:999}).every(p=>p.maxSelections===40));
  for(const value of [0,20,79.9,''])assert.equal(hourlyModelPlans({TELEGRAM_HOURLY_QC_MIN_PROBABILITY:value})[1].minProbability,0);
  assert.ok(hourlyModelPlans({TELEGRAM_HOURLY_QC_MIN_PROBABILITY:99,TELEGRAM_HOURLY_LIVE_MIN_PROBABILITY:99}).every(p=>p.minProbability===0));
});
test('one initial scan builds three target tickets, tracking every selection and combined model chance',async()=>{
  const h=harness(),result=await h.run();assert.equal(result.ticketsSent,3);assert.equal(h.scans(),1);assert.equal(h.validations(),3);
  assert.equal(h.bookings.length,3);assert.equal(h.codes.length,3);assert.equal(h.messages.length,3);
  for(const [i,r] of result.results.entries()){
    assert.ok(r.combinedOdds>=result.plans[i].targetOdds);assert.ok(r.selections<=40);assert.ok(r.estimatedWinningProbability>0);
    assert.match(h.messages[i],/Estimated combined chance:/);assert.match(h.messages[i],/SportyBet code: MODEL-/);
  }
  assert.equal((await listTrackedSlips(h.redis)).length,3);assert.ok((await listTrackedSlips(h.redis)).every(t=>t.delivery==='posted'));
  assert.ok(result.results.at(-1).estimatedWinningProbability<5,'strong individual picks do not imply a high combined accumulator chance');
});
test('safest selection ranks the product of probabilities rather than average leg probability',async()=>{
  const h=harness({rows:[row('single',{odds:3,probability:85}),...Array.from({length:15},(_,i)=>row('short'+i,{odds:1.08,probability:98}))]});
  const result=await h.run();assert.equal(result.results[0].sent,true);assert.equal(result.results[0].selections,1);assert.equal(h.bookings[0][0].eventId,'live-single');
});
test('halfway Live 3 is eligible while QC 3 requires the late stage',async()=>{
  const h=harness({rows:[row('football',{sport:'Football',marketId:'1',outcomeId:'1',betType:'home_win',odds:3,liveState:{phase:'2nd half',minute:55,homeScore:2,awayScore:0}})]});
  const result=await h.run();assert.equal(result.ticketsSent,2);assert.equal(result.results[0].sent,true);assert.equal(result.results[1].reason,'no_eligible_live_games');
});
test('hourly Live and QC accept lower estimates despite configured historical floors',async()=>{
  const h=harness({rows:[row('available',{odds:3,probability:20})],env:{TELEGRAM_HOURLY_LIVE_MIN_PROBABILITY:99,TELEGRAM_HOURLY_QC_MIN_PROBABILITY:99}});
  const result=await h.run();assert.equal(result.ticketsSent,3);assert.ok(result.results.every(r=>r.minProbability===0));
  assert.ok(h.messages.every(m=>m.includes('no minimum probability cutoff')));
  for(const probability of [0,-1,101,NaN]){
    const invalid=harness({rows:[row('invalid',{odds:3,probability})]});assert.equal((await invalid.run()).ticketsSent,0);
  }
});
test('early, finished, losing, tied-winner, prematch and unknown-score matches cannot be booked',async()=>{
  const h=harness({rows:[row('early',{liveState:{phase:'1st period',minute:10,homeScore:3,awayScore:1}}),
    row('finished',{liveState:{phase:'FT',homeScore:3,awayScore:1}}),row('losing',{liveState:{phase:'3rd period',homeScore:1,awayScore:3}}),
    row('tie',{liveState:{phase:'3rd period',homeScore:1,awayScore:1}}),row('prematch',{live:false}),row('unknown',{liveState:{phase:'3rd period'}})]});
  const result=await h.run();assert.equal(result.ticketsSent,0);assert.equal(h.bookings.length,0);assert.equal(h.messages.length,1);
  assert.equal(result.reason,'no_eligible_hourly_target_tickets');await h.run();assert.equal(h.messages.length,1);
});
test('each ticket has one selection per fixture and the larger Live plan accepts a lower available total',async()=>{
  const h=harness({rows:[row('duplicate',{odds:3}),row('duplicate',{marketId:'total',betType:'hockey_under',specifier:'total=9.5',outcomeDesc:'Under 9.5',marketDesc:'Total Goals',odds:3})]});
  const result=await h.run();assert.equal(result.ticketsSent,3);assert.ok(h.bookings.every(s=>s.length===1));assert.equal(result.results.at(-1).lowerTarget,true);
  assert.equal(h.codes.length,3);assert.match(h.messages.at(-1),/Lower available target used/);
});
test('fresh probabilities are used for reporting and ranking without an old floor',async()=>{
  const h=harness();h.deps.validate=async selections=>({valid:selections.map(c=>({...c,probability:50}))});
  const result=await h.run();assert.equal(result.ticketsSent,3);assert.ok(h.messages.every(m=>m.includes('Model 50.0%')));
});
test('the final public scan rejects missing model estimates before any booking POST',async()=>{
  const h=harness();h.deps.validate=async selections=>({valid:selections.map(c=>({...c,probability:NaN}))});
  const result=await h.run();assert.equal(result.ticketsSent,0);assert.equal(h.bookings.length,0);
});
test('a short board produces a lower Live total while strict 3-odds plans remain unavailable',async()=>{
  const h=harness({rows:[row('only',{odds:1.5,probability:75})]});const result=await h.run();
  assert.equal(result.ticketsSent,1);assert.equal(result.results[0].reason,'target_unreachable');assert.equal(result.results[1].reason,'target_unreachable');
  assert.equal(result.results[2].combinedOdds,1.5);assert.equal(result.results[2].lowerTarget,true);
});
test('a fresh live board chooses the safest combination at the lower achievable target',async()=>{
  const h=harness();h.deps.validate=async()=>({valid:[],candidates:[row('one',{odds:4,probability:40}),row('one',{marketId:'other',odds:4,probability:90}),row('two',{odds:5,probability:70})]});
  const result=await h.run();assert.equal(result.ticketsSent,3);assert.equal(result.results[2].combinedOdds,20);
  assert.equal(h.bookings[2].find(c=>c.eventId==='live-one').marketId,'other');
});
test('a fresh board can replace the initial combination with a newly safer complete target',async()=>{
  const h=harness();h.deps.validate=async()=>({valid:[],candidates:[row('new-best',{odds:1000,probability:99})]});
  const result=await h.run();assert.equal(result.ticketsSent,3);assert.ok(h.bookings.every(s=>s.length===1&&s[0].eventId==='live-new-best'));
});
test('removed markets and losing scores cannot produce a code',async()=>{
  for(const change of [()=>null,c=>({...c,liveState:{...c.liveState,homeScore:0,awayScore:4}})]){
    const h=harness();h.deps.validate=async selections=>({valid:selections.map(change).filter(Boolean)});
    const result=await h.run();assert.equal(result.ticketsSent,0);assert.equal(h.bookings.length,0);assert.ok(result.results.every(r=>r.reason==='live_markets_changed_or_target_not_reached'));
  }
});
test('confirmed source failures are retryable, scan only once and send no empty-slate notice',async()=>{
  const h=harness({loadPool:async()=>{h.calls=(h.calls||0)+1;throw Object.assign(Error('Public live feed unavailable'),{code:'SPORTYBET_SOURCE_UNAVAILABLE',diagnostics:{sourceErrors:{'hockey/winner':'HTTP 503'}}});}});
  const result=await h.run();assert.equal(h.calls,1);assert.equal(result.retryable,true);assert.equal(h.messages.length,0);assert.equal(h.bookings.length,0);
  assert.ok(result.results.every(r=>r.diagnostics.sourceErrors['hockey/winner']==='HTTP 503'));
});
test('retrying a confirmed booking rejection only builds the unsent plan',async()=>{
  const h=harness(),book=h.deps.book;let attempts=0;
  h.deps.book=async selections=>{if(++attempts===1)throw Object.assign(Error('Suspended selection'),{status:400});return book(selections);};
  assert.equal((await h.run()).ticketsSent,2);assert.equal((await h.run()).ticketsSent,1);assert.equal(h.bookings.length,3);assert.equal(h.messages.length,3);
});
test('a known prepared code survives a save failure and is delivered on retry without rebooking',async()=>{
  const h=harness(),save=h.deps.saveCode;let attempts=0;
  h.deps.saveCode=async(...args)=>{if(++attempts===1)throw Error('Temporary code storage failure');return save(...args);};
  const first=await h.run();assert.equal(first.retryable,true);assert.equal(first.ticketsSent,2);assert.equal(h.bookings.length,3);
  assert.equal(JSON.parse(await h.redis.get(STATE_PREFIX+h.context.slotKey+':live_3')).status,'prepared');
  assert.equal((await h.run()).ticketsSent,1);assert.equal(h.bookings.length,3);assert.equal(h.messages.length,3);
});
test('an uncertain booking POST is reserved and cannot be automatically repeated',async()=>{
  const h=harness(),book=h.deps.book;let attempts=0;
  h.deps.book=async selections=>{if(++attempts===1)throw Object.assign(Error('Booking response timed out'),{bookingOutcomeUnknown:true});return book(selections);};
  const first=await h.run();assert.equal(first.results[0].bookingOutcomeUnknown,true);await h.run();assert.equal(attempts,3);assert.equal(h.messages.length,2);
});
test('a process interrupted after starting booking cannot trigger another POST on restart',async()=>{
  const h=harness();await h.redis.set(STATE_PREFIX+h.context.slotKey+':live_3',JSON.stringify({status:'booking_started'}));
  const result=await h.run();assert.equal(result.results[0].bookingOutcomeUnknown,true);assert.equal(h.bookings.length,2);
});
test('an ambiguous Telegram send is recorded as unknown and never repeated',async()=>{
  const h=harness(),send=h.deps.send;let attempts=0;
  h.deps.send=async text=>{if(++attempts===1)throw Error('Telegram send timed out');return send(text);};
  const first=await h.run();assert.equal(first.results[0].deliveryUnknown,true);await h.run();assert.equal(attempts,3);assert.equal(h.bookings.length,3);
  assert.equal((await listTrackedSlips(h.redis)).filter(t=>t.delivery==='unknown').length,1);
});
test('a lost lease stops sending and retains the prepared code for the current owner',async()=>{
  const h=harness();let checks=0;
  const first=await h.run({assertLease:async()=>{if(++checks>2)throw Object.assign(Error('lease lost'),{code:'TELEGRAM_RUN_LEASE_LOST'});}});
  assert.equal(first.ticketsSent,0);assert.equal(h.messages.length,0);assert.equal(h.bookings.length,1);
  assert.equal((await h.run()).ticketsSent,3);assert.equal(h.bookings.length,3);
});
test('repeated hours deduplicate tickets, while the next hour has independent new records',async()=>{
  const h=harness();await h.run();assert.equal((await h.run()).ticketsSent,0);assert.equal(h.scans(),1);
  await h.run({slotKey:'2026-10-08T13',hourKey:'2026-10-08T13',slotTime:'13:05'});assert.equal(h.bookings.length,6);assert.equal((await listTrackedSlips(h.redis)).length,6);
});
test('cancellation after public collection prevents any later booking or sending',async()=>{
  const h=harness(),controller=new AbortController(),read=h.deps.loadPool;
  h.deps.loadPool=async()=>{const result=await read();controller.abort();return result;};
  await assert.rejects(h.run({signal:controller.signal}),/cancelled/);assert.equal(h.bookings.length,0);assert.equal(h.messages.length,0);
});
test('long 40-game tickets include every game and repeat the code on each Telegram-sized chunk',()=>{
  const plan=hourlyModelPlans({}).at(-1),selections=Array.from({length:40},(_,i)=>row(i,{home:'H'.repeat(90)+i,away:'A'.repeat(90)+i}));
  const chunks=hourlyTicketText(plan,{selections,combinedOdds:7523,estimatedWinningProbability:1},{shareCode:'LONG-CODE'},
    {dateKey:'2026-10-08',hourKey:'2026-10-08T12',slotTime:'12:05'});
  assert.ok(chunks.length>1);assert.ok(chunks.every(c=>c.length<=3900&&c.includes('LONG-CODE')));
  for(let i=1;i<=40;i++)assert.equal(chunks.join('\n').match(new RegExp('\\n'+i+'\\. ','g')).length,1);
});

test('falling prices allow a refreshed lower Live total while both 3-odds tickets are skipped',async()=>{
  const h=harness();h.deps.validate=async selections=>({valid:selections.map(c=>({...c,odds:1.01}))});
  const result=await h.run();assert.equal(result.ticketsSent,1);assert.equal(result.results[2].lowerTarget,true);
  assert.ok(result.results[2].combinedOdds<1000);assert.equal(h.bookings.length,1);
});
test('a prepared code cannot be sent with a removed leg hidden by the lower-target allowance',async()=>{
  const h=harness(),save=h.deps.saveCode;let count=0;
  h.deps.saveCode=async(...args)=>{if(++count===3)throw Error('save unavailable');return save(...args);};
  assert.equal((await h.run()).ticketsSent,2);h.deps.validate=async selections=>({valid:selections.slice(1)});
  assert.equal((await h.run()).ticketsSent,0);assert.equal(h.messages.filter(m=>m.includes('SportyBet code:')).length,2);assert.equal(h.bookings.length,3);
});
