'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PLANS,buildNext12hPack,bestProbabilityTicket,ticketSignature,emptyUsage,recordSelections,canUse,runNext12hPicks}=require('../lib/telegramNext12h');
const {selectionKey}=require('../lib/sportyPublicCache');
const {fakeRedis}=require('./fixtures/fake-redis');
const now=new Date('2026-10-07T06:00:00Z');
const leg=(id,type='type',odds=3,probability=80)=>({sport:'Football',eventId:String(id),marketId:type,outcomeId:'1',specifier:null,betType:type,
  home:'Home '+id,away:'Away '+id,marketDesc:type,outcomeDesc:'Home',odds,probability,kickoffUtc:new Date(now.getTime()+3600000).toISOString(),live:false});
const pool=()=>Array.from({length:6},(_,i)=>Array.from({length:15},(_,j)=>leg(`${i}-${j}`,'type'+i))).flat();
test('six target variations use separate fixtures and bet types when probabilities are below 90%',()=>{
  const pack=buildNext12hPack(pool(),{now});assert.deepEqual(pack.plans.map(p=>p.targetOdds),[10000,2500,500,100,100,100]);
  const used=emptyUsage();for(const plan of pack.plans){assert.equal(plan.reachedTarget,true,plan.id);assert.ok(plan.combinedOdds+1e-9>=plan.targetOdds);
    for(const c of plan.selections){assert.equal(used.events.has(c.eventId),false);assert.equal(used.types.has(c.betType),false);}
    recordSelections(used,plan.selections);}
});
test('the same 90% pick can recur on three tickets; no other outcome of that match or type can recur',()=>{
  const c=leg('shared','home_win',1.1,90),used=emptyUsage();recordSelections(used,[c]);assert.equal(canUse(c,used),true);
  assert.equal(canUse({...c,outcomeId:'2'},used),false);assert.equal(canUse(leg('other','home_win',2,95),used),false);
  assert.equal(canUse({...c,betType:'over25',marketId:'18'},used),false);
  recordSelections(used,[c]);assert.equal(canUse(c,used),true);recordSelections(used,[c]);assert.equal(canUse(c,used),false);
  const weaker=emptyUsage();recordSelections(weaker,[{...c,probability:89.9}]);assert.equal(canUse(c,weaker),false);
});
test('ticket search ranks combined winning probability rather than average per-leg probability',()=>{
  const choices=[leg('single','one',100,.80*100),...Array.from({length:7},(_,i)=>leg('small'+i,'two',2,95))];
  const result=bestProbabilityTicket(choices,100);assert.equal(result.selections.length,1);assert.equal(result.selections[0].eventId,'single');assert.ok(Math.abs(result.estimatedWinningProbability-80)<1e-8);
});
test('the rolling twelve-hour window excludes started, live and later games and never books an undershoot',()=>{
  const candidates=pool();candidates.push(leg('expired','extra',1e6,99),leg('live','extra',1e6,99),leg('late','extra',1e6,99));
  candidates.at(-3).kickoffUtc=now.toISOString();candidates.at(-2).live=true;candidates.at(-1).kickoffUtc=new Date(now.getTime()+12*3600000+1).toISOString();
  const pack=buildNext12hPack(candidates,{now});assert.ok(pack.plans.every(p=>p.selections.every(c=>!['expired','live','late'].includes(c.eventId))));
  const impossible=buildNext12hPack([leg('only','one',2,99)],{now});assert.ok(impossible.plans.every(p=>!p.reachedTarget));
  const capped=bestProbabilityTicket(pool(),10000,{maxSelections:2});assert.equal(capped.reachedTarget,false);assert.ok(capped.selections.length<=2);
});
function harness(overrides={}){
  const redis=fakeRedis(),messages=[],bookings=[],saved=[],tracked=new Map();let checks=0;
  const context={redis,slotKey:'2026-10-07T07:00',dateKey:'2026-10-07',slotTime:'07:00',shouldAbort:()=>false};
  const deps={now:()=>now,loadPool:async()=>pool(),validate:async selections=>selections,assertBookingReady:async()=>{checks++;},
    book:async selections=>{bookings.push(selections);return {shareCode:'NEXT-'+bookings.length};},send:async text=>{messages.push(text);},
    track:async(_r,ticket)=>tracked.set(ticket.ticketId,ticket),updateTrack:async(_r,id,patch)=>Object.assign(tracked.get(id),patch),
    saveCode:async(...args)=>saved.push(args),...overrides};
  return {redis,messages,bookings,saved,tracked,context,deps,checks:()=>checks};
}
test('one batch generates six codes, tracks six stakes and cannot resend after restart',async()=>{
  const h=harness(),result=await runNext12hPicks(h.deps,h.context);assert.equal(result.ticketsSent,6);assert.equal(h.checks(),1);
  assert.equal(h.messages.length,6);assert.equal(h.saved.length,6);assert.equal(h.tracked.size*100,600);
  assert.ok([...h.tracked.values()].every(t=>t.delivery==='posted'));
  const restarted=await runNext12hPicks(h.deps,h.context);assert.equal(restarted.ticketsSent,0);assert.equal(h.bookings.length,6);
  assert.ok(h.messages.every(m=>m.includes('NEXT 12H')&&m.includes('SportyBet code: NEXT-')));
});
test('a transient booking failure retries only the failed plan',async()=>{
  let count=0;const h=harness();const book=h.deps.book;h.deps.book=async selections=>{if(++count===1)throw new Error('transient booking');return book(selections);};
  const first=await runNext12hPicks(h.deps,h.context);assert.equal(first.ticketsSent,5);assert.equal(first.retryable,true);
  const second=await runNext12hPicks(h.deps,h.context);assert.equal(second.ticketsSent,1);assert.equal(h.messages.length,6);
});
test('an uncertain Telegram send reserves its matches and is never automatically repeated',async()=>{
  let count=0;const h=harness({send:async()=>{if(++count===1)throw new Error('ambiguous send');}});
  const first=await runNext12hPicks(h.deps,h.context);assert.equal(first.ticketsSent,5);assert.equal(first.results[0].deliveryUnknown,true);
  const second=await runNext12hPicks(h.deps,h.context);assert.equal(second.ticketsSent,0);assert.equal(count,6);
  assert.equal([...h.tracked.values()].filter(t=>t.delivery==='unknown').length,1);
});
test('changed prices or missing markets cannot cause a lower-target booking',async()=>{
  const h=harness({validate:async selections=>selections.map(c=>({...c,odds:1.01}))});
  const result=await runNext12hPicks(h.deps,h.context);assert.equal(result.ticketsSent,0);assert.equal(h.bookings.length,0);assert.equal(h.checks(),0);
  assert.ok(result.results.every(r=>r.reason==='markets_changed_or_target_not_reached'));
});
test('pack-wide repeated picks always obey the three-ticket maximum',()=>{
  const candidates=pool().map(c=>({...c,probability:95})),pack=buildNext12hPack(candidates,{now}),seen=new Map();
  for(const plan of pack.plans)if(plan.reachedTarget)for(const c of plan.selections){const key=selectionKey(c);seen.set(key,(seen.get(key)||0)+1);}
  assert.ok([...seen.values()].every(n=>n<=3));assert.ok(pack.plans.every(p=>p.reachedTarget));
  assert.equal(new Set(pack.plans.slice(-3).map(p=>ticketSignature(p.selections))).size,3);
});
test('even shared 90% picks cannot produce three identical 100x variations',()=>{
  const pack=buildNext12hPack(pool().map(c=>({...c,probability:95,odds:5})),{now});
  assert.ok(pack.plans.every(p=>p.reachedTarget));assert.equal(new Set(pack.plans.slice(-3).map(p=>ticketSignature(p.selections))).size,3);
});
test('short-priced high-probability families are reserved for targets reachable within 40 games',()=>{
  const odds=[1.2,2,3,4,5,6],probabilities=[95,80,75,70,65,60];
  const candidates=Array.from({length:6},(_,i)=>Array.from({length:40},(_,j)=>leg(i+'-'+j,'type'+i,odds[i],probabilities[i]))).flat();
  const pack=buildNext12hPack(candidates,{now});assert.ok(pack.plans.every(p=>p.reachedTarget));
  assert.ok(pack.plans[0].assignedBetTypes.includes('type1'));assert.ok(pack.plans.every(p=>p.selections.length<=40));
});
test('90% repeat tickets wait for their source ticket after a transient booking failure',async()=>{
  const odds=[1.2,2,3,4,5,6],probabilities=[95,80,75,70,65,60];
  const candidates=Array.from({length:6},(_,i)=>Array.from({length:40},(_,j)=>leg(i+'-'+j,'type'+i,odds[i],probabilities[i]))).flat();
  const h=harness({loadPool:async()=>candidates}),book=h.deps.book;let failed=false;
  h.deps.book=async selections=>{if(!failed&&selections.some(c=>c.betType==='type0')){failed=true;throw new Error('source ticket temporarily unavailable');}return book(selections);};
  const first=await runNext12hPicks(h.deps,h.context);assert.equal(first.retryable,true);
  assert.ok(first.results.some(r=>r.reason==='shared_pick_source_ticket_unavailable'));
  const second=await runNext12hPicks(h.deps,h.context);assert.equal(first.ticketsSent+second.ticketsSent,6);assert.equal(h.messages.length,6);
});
