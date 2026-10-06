'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {reportWindow,totals,buildPerformanceReport,performanceText,refreshTicketResults,registerTelegramPerformanceRoute}=require('../lib/telegramPerformance');
const {trackTelegramSlip,listTrackedSlips,updateTrackedTicket}=require('../lib/slipTracker');
const {fakeRedis}=require('./fixtures/fake-redis');
const selection={eventId:'e',marketId:'1',outcomeId:'1',sport:'Football',home:'Alpha',away:'Beta',betType:'home_win',marketDesc:'1X2',outcomeDesc:'Home',odds:2};
function slip(code,status,multiplier,extra={}) {
  return {ticketId:code,shareCode:code,label:'QC FOOTBALL',delivery:'posted',postedAt:'2026-10-06T04:00:00Z',createdAt:'2026-10-06T04:00:00Z',
    selections:[selection],status,lastStatusDetail:{status,returnMultiplier:multiplier,complete:status!=='pending',totalLegs:1,
      counts:{won:status==='won'?1:0,lost:status==='lost'?1:0,push:status==='push'?1:0,half_won:0,half_lost:0,pending:status==='pending'?1:0},
      legDetails:[{...selection,status,returnMultiplier:multiplier}]},...extra};
}
test('report windows are exact completed WAT half-days across noon and midnight',()=>{
  assert.deepEqual(reportWindow(new Date('2026-10-06T11:10:00Z')),{key:'2026-10-06T12',start:'2026-10-05T23:00:00.000Z',end:'2026-10-06T11:00:00.000Z'});
  assert.deepEqual(reportWindow(new Date('2026-10-06T23:10:00Z')),{key:'2026-10-07T00',start:'2026-10-06T11:00:00.000Z',end:'2026-10-06T23:00:00.000Z'});
});
test('100-naira ROI uses priced settlements, adjusts refunds and leaves pending stakes unresolved',()=>{
  const result=totals([slip('W','won',2),slip('L','lost',0),slip('V','push',1),slip('HW','won',1.4),
    slip('HL','partial_loss',.5),slip('P','pending',null),slip('UNPRICED','won',null)]);
  assert.equal(result.stake,700);assert.equal(result.settledStake,500);assert.equal(result.pendingStake,200);
  assert.equal(result.returns,490);assert.equal(result.profit,-10);assert.equal(result.roiPct,-2);
  assert.equal(totals([slip('P','pending',null)]).roiPct,null);
});
test('closest and worst compare completed losing tickets; winners and winning selections are listed',()=>{
  const rows=[slip('WIN','won',2),slip('CLOSE','lost',0),slip('WORST','lost',0),slip('INCOMPLETE','lost',0),
    slip('OLD','won',2,{postedAt:'2026-10-05T04:00:00Z'}),slip('NEW','pending',null,{postedAt:'2026-10-06T11:01:00Z'}),slip('UNKNOWN-SEND','won',2,{delivery:'unknown'})];
  Object.assign(rows[1].lastStatusDetail,{totalLegs:3,counts:{won:2,lost:1,push:0,half_won:0,half_lost:0,pending:0}});
  Object.assign(rows[2].lastStatusDetail,{totalLegs:2,counts:{won:0,lost:2,push:0,half_won:0,half_lost:0,pending:0}});
  rows[3].lastStatusDetail.complete=false;
  const report=buildPerformanceReport(rows,reportWindow(new Date('2026-10-06T11:10:00Z')));
  assert.equal(report.period.tickets,4);assert.equal(report.cumulative.tickets,6);assert.equal(report.closest.shareCode,'CLOSE');assert.equal(report.worst.shareCode,'WORST');
  assert.equal(report.wonTickets[0].shareCode,'WIN');assert.equal(report.winningGames.length,1);assert.equal(report.unknownDeliveries,1);
  const text=performanceText(report);assert.match(text,/Closest shot: QC FOOTBALL · CLOSE/);assert.match(text,/Worst: QC FOOTBALL · WORST/);
  assert.match(text,/Alpha vs Beta/);assert.match(text,/ROI uses settled, priced tickets only/);
});
test('no confirmed results cannot imply a 100% loss',()=>{
  const report=buildPerformanceReport([slip('P','pending',null)],reportWindow(new Date('2026-10-06T11:10:00Z')));
  assert.equal(report.period.profit,0);assert.equal(report.period.pendingStake,100);
  assert.match(performanceText(report),/ROI: pending/);assert.doesNotMatch(performanceText(report),/ROI: -100/);
});
test('a ticket from an earlier window that settles now is still reported by code',()=>{
  const row=slip('EARLIER','won',2,{postedAt:'2026-10-05T04:00:00Z'});
  const report=buildPerformanceReport([row],reportWindow(new Date('2026-10-06T11:10:00Z')),['EARLIER']);
  assert.equal(report.period.tickets,0);assert.equal(report.cumulative.profit,100);
  assert.match(performanceText(report),/EARLIER TICKETS NOW UPDATED[\s\S]*EARLIER — WON/);
});
test('atomic ticket storage keeps multiple posted copies of the same code and imports old records once',async()=>{
  const redis=fakeRedis();await redis.set('telegram:tracked-slips:v1',JSON.stringify([slip('OLD','pending',null)]));
  await Promise.all([trackTelegramSlip(redis,{ticketId:'19:qc_football',shareCode:'ABC123',selections:[selection]}),
    trackTelegramSlip(redis,{ticketId:'20:qc_football',shareCode:'ABC123',selections:[selection]})]);
  await updateTrackedTicket(redis,'OLD',{status:'lost'});
  const all=await listTrackedSlips(redis);assert.equal(all.length,3);assert.equal(all.filter(r=>r.shareCode==='ABC123').length,2);
  assert.equal(all.find(r=>r.shareCode==='OLD').status,'lost');
});
test('results read SportyBet afresh, deduplicate common events and keep unresolved selections pending',async()=>{
  const redis=fakeRedis();
  await trackTelegramSlip(redis,{ticketId:'first',shareCode:'ABC123',selections:[selection]});
  await trackTelegramSlip(redis,{ticketId:'second',shareCode:'ABC123',selections:[selection]});
  let bookings=0,events=0,sessions=0;
  const result=await refreshTicketResults(redis,{assertSession:async()=>{sessions++;},getBooking:async()=>{bookings++;return {outcomes:[]};},
    getEvent:async()=>{events++;return {data:{eventId:'e',matchStatus:'FT',setScore:'2:0'}};}});
  assert.equal(result.checked,2);assert.equal(sessions,1);assert.equal(bookings,1);assert.equal(events,1);
  assert.ok((await listTrackedSlips(redis)).every(s=>s.status==='won'&&s.lastStatusDetail.returnMultiplier===2));
  await trackTelegramSlip(redis,{ticketId:'pending',shareCode:'XYZ123',selections:[{...selection,eventId:'unknown'}]});
  await refreshTicketResults(redis,{assertSession:async()=>{},getBooking:async()=>{throw Error('not available');},getEvent:async()=>({data:{}})});
  assert.equal((await listTrackedSlips(redis)).find(s=>s.ticketId==='pending').status,'pending');
});
test('official voids and half settlements adjust the returned price without reading unavailable results',async()=>{
  const redis=fakeRedis();await trackTelegramSlip(redis,{shareCode:'HALF123',selections:[selection,{...selection,eventId:'v',odds:3}]});
  const result=await refreshTicketResults(redis,{assertSession:async()=>{},getBooking:async()=>({outcomes:[
    {...selection,settlement:'HALF_WON'},{...selection,eventId:'v',settlement:'VOID'}]}),getEvent:async()=>{throw Error('should not read');}});
  assert.equal(result.errors,0);const ticket=(await listTrackedSlips(redis))[0];assert.equal(ticket.lastStatusDetail.returnMultiplier,1.5);
});
test('missing dummy session leaves every unconfirmed result pending for reporting',async()=>{
  const redis=fakeRedis();await trackTelegramSlip(redis,{shareCode:'ABC123',selections:[selection]});
  const result=await refreshTicketResults(redis,{assertSession:async()=>{throw Error('expired');},getBooking:async()=>assert.fail('anonymous fallback forbidden')});
  assert.equal(result.sessionUnavailable,true);assert.equal((await listTrackedSlips(redis))[0].status,'pending');
});
test('result scan limits preserve unchecked tickets and continue on the next report',async()=>{
  const redis=fakeRedis();for(let i=0;i<3;i++)await trackTelegramSlip(redis,{shareCode:'CODE'+i,selections:[selection]});
  const deps={maxTickets:1,assertSession:async()=>{},getBooking:async()=>({}),getEvent:async()=>({data:{eventId:'e',matchStatus:'FT',setScore:'2:0'}})};
  const first=await refreshTicketResults(redis,deps);assert.equal(first.checked,1);assert.equal(first.remainingChecks,2);
  const next=await refreshTicketResults(redis,deps);assert.equal(next.remainingChecks,1);
});
function routeHarness(runReport,{redis=fakeRedis()}={}) {
  let handler,clock=new Date('2026-10-06T11:10:00Z');
  registerTelegramPerformanceRoute({post(route,_middleware,fn){assert.equal(route,'/api/telegram/performance-report');handler=fn;}},
    {express:{json:()=>()=>{}},authorize:req=>req.headers.secret==='yes',getRedis:async()=>redis,runReport,now:()=>clock,logger:{error(){}}});
  const request=(authorized=true)=>{const res=new EventEmitter();Object.assign(res,{destroyed:false,writableEnded:false,statusCode:200});
    res.status=c=>{res.statusCode=c;return res;};res.json=body=>{res.body=body;res.writableEnded=true;return res;};return {res,done:handler({headers:{secret:authorized?'yes':'no'}},res)};};
  return {request,redis,setClock:iso=>{clock=new Date(iso);}};
}
test('report endpoint authenticates, requires Redis and posts once per 12-hour window',async()=>{
  let sends=0;const h=routeHarness(async({onPostingStart})=>{await onPostingStart();sends++;return {sent:true};});
  const unauthorized=h.request(false);await unauthorized.done;assert.equal(unauthorized.res.statusCode,401);
  const first=h.request();await first.done;const again=h.request();await again.done;assert.equal(again.res.body.reason,'already_reported_this_period');
  assert.equal(sends,1);h.setClock('2026-10-06T23:10:00Z');await h.request().done;assert.equal(sends,2);
  const offline=routeHarness(async()=>assert.fail(),{redis:null}).request();await offline.done;assert.equal(offline.res.statusCode,503);
});
test('pre-post report failure can retry; an ambiguous Telegram delivery cannot repost',async()=>{
  let tries=0;const h=routeHarness(async()=>{if(++tries===1)throw Error('result reads failed');return {sent:true};});
  await h.request().done;const retry=h.request();await retry.done;assert.equal(retry.res.statusCode,200);
  const unknown=routeHarness(async({onPostingStart})=>{await onPostingStart();throw Error('Telegram timeout');});
  const failed=unknown.request();await failed.done;assert.equal(failed.res.statusCode,502);
  const dup=unknown.request();await dup.done;assert.equal(dup.res.body.reason,'already_reported_this_period');
});
