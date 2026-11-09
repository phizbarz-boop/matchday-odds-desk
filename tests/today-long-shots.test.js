'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../lib/telegramFloorPicks'),T=require('../lib/todayLongShots');
const {ticketSignature}=require('../lib/telegramNext12h');
const now=new Date('2026-11-05T06:00:00Z'),dateKey='2026-11-05';
const pool=Array.from({length:36},(_,i)=>({eventId:'E'+i,marketId:'1',outcomeId:'1',betType:'home_win',sport:i%2?'Football':'Basketball',kickoffUtc:new Date(+now+(60+i*10)*60000).toISOString(),odds:1.4,probability:65-i/2,home:'Home '+i,away:'Away '+i}));
test('one 30-game ticket meets the 100k target and use today WAT only without a probability floor',()=>{
 const priced=pool.map(c=>({...c,odds:1.5}));
 const rows=[...priced,{...pool[0],eventId:'tomorrow',kickoffUtc:'2026-11-05T23:00:00Z',probability:99},{...pool[0],eventId:'unknown',probability:null},{...pool[0],eventId:'live',live:true,probability:99}];
 const {plans}=F.buildPack(rows,{now,dateKey,plans:T.PLANS});assert.equal(plans.length,1);assert.equal(plans[0].targetOdds,100000);
 for(const p of plans){assert.equal(p.selections.length,30);assert.equal(new Set(p.selections.map(c=>c.eventId)).size,30);assert.ok(p.selections.reduce((n,c)=>n*c.odds,1)>=100000);assert.ok(p.selections.every(c=>priced.includes(c)));assert.ok(p.selections.every((c,i)=>!i||c.kickoffUtc>=p.selections[i-1].kickoffUtc));}
 assert.equal(F.buildPack(pool.slice(0,29),{now,dateKey,plans:T.PLANS}).plans[0].selections.length,29);
});
test('daily workflow saves one confirmed code and allows repricing above 1,000 and rejects lower odds',async()=>{
 const {fakeRedis}=require('./fixtures/fake-redis');const codes=[],messages=[];let books=0;
 const deps={plans:T.PLANS,now:()=>now,loadPool:async()=>pool,validate:async x=>x,book:async()=>({shareCode:'TODAY'+(++books)}),saveCode:async(_r,_d,c)=>codes.push(c),send:async t=>messages.push(t),track:async()=>{},updateTrack:async()=>{}};
 const ctx={redis:fakeRedis(),dateKey,slotKey:'test',slotTime:'07:00',manualTest:true};
 const run=await F.runFloorPicks(deps,ctx);assert.equal(run.ticketsSent,1);assert.equal(codes.length,1);assert.ok(messages.every(t=>t.includes('30 games')&&t.includes('Kickoff order')&&t.length<4096));
 assert.equal(require('../lib/telegramCodeSession').currentCodes(codes,new Date('2026-11-05T06:30:00Z')).length,1);
 deps.validate=async rows=>rows.map(c=>({...c,odds:1.3}));await F.runFloorPicks(deps,{...ctx,slotKey:'fallback'});assert.equal(books,2);assert.ok(messages.slice(1).every(t=>t.includes('(fallback)')));
 deps.validate=async rows=>rows.map(c=>({...c,odds:1.01}));await F.runFloorPicks(deps,{...ctx,slotKey:'reprice'});assert.equal(books,2);
});
test('fallback accepts fewer games above 1,000 and skips odds at or below 1,000',()=>{
 const rows=pool.slice(0,28).map(c=>({...c,odds:1.3}));
 const result=F.buildPack(rows,{now,dateKey,plans:T.PLANS}).plans[0].selections;
 assert.equal(result.length,28);assert.ok(result.reduce((n,c)=>n*c.odds,1)>1000);
 assert.equal(T.choose([10,10,10].map((odds,i)=>({...pool[i],odds})),{now}).length,0);
});
test('finish deadline includes the next WAT day but excludes the following midnight',()=>{
 assert.ok(T.eligible({...pool[0],scheduledEndUtc:'2026-11-06T22:59:00Z'},now,dateKey));
 assert.equal(T.eligible({...pool[0],scheduledEndUtc:'2026-11-06T23:00:00Z'},now,dateKey),false);
 assert.equal(T.eligible({...pool[0],scheduledEndUtc:'bad'},now,dateKey),false);
});
test('correct-score markets and concentrated prices are excluded even on fresh validation',async()=>{
 const {fakeRedis}=require('./fixtures/fake-redis');
 const score={...pool[0],betType:'offered:99',marketDesc:'First Half Correct Score',odds:1.99};
 const expensive={...pool[1],odds:2.01,probability:95};
 assert.equal(T.eligible(score,now,dateKey),false);
 assert.equal(T.eligible({...pool[0],betType:'correct_score'},now,dateKey),false);
 assert.equal(T.eligible(expensive,now,dateKey),false);
 const rows=[score,expensive,...pool];
 assert.ok(T.choose(rows,{now}).every(c=>c!==score&&c!==expensive));
 let booked;
 const deps={plans:T.PLANS.slice(0,1),now:()=>now,loadPool:async()=>pool,validate:async rows=>rows.map((c,i)=>i===0?{...c,marketDesc:'Exact Match Score'}:i===1?{...c,odds:2.01}:c),book:async legs=>{booked=legs;return{shareCode:'BALANCED'}},saveCode:async()=>{},send:async()=>{},track:async()=>{},updateTrack:async()=>{}};
 await F.runFloorPicks(deps,{redis:fakeRedis(),dateKey,slotKey:'balanced',slotTime:'07:00',manualTest:true});
 assert.equal(booked.length,28);
 assert.ok(booked.every(c=>c.odds<=2&&!c.marketDesc));
});
test('equally strong fixtures with identical odds favor earlier kickoffs',()=>{
 const base=pool.slice(0,30).map(c=>({...c,odds:1.4,probability:95}));
 const late={...base[0],eventId:'later',kickoffUtc:'2026-11-05T14:00:00Z'};
 const picks=T.choose([late,...base],{now});
 assert.equal(picks.length,30);
 assert.ok(picks.includes(base[0]));
 assert.ok(!picks.includes(late));
});
test('The daily ticket rebuilds from freshly checked reserves after losing legs',async()=>{
 const {fakeRedis}=require('./fixtures/fake-redis');
 const booked=[],codes=[];
 const deps={plans:T.PLANS,now:()=>now,loadPool:async()=>pool,
  validate:async(rows,{plan})=>plan.id==='today10k1'&&rows.length===30?rows.slice(0,16):rows,
  book:async legs=>{booked.push(legs);return{shareCode:'RECOVERED'+booked.length}},
  saveCode:async(_redis,_date,code)=>codes.push(code),send:async()=>{},track:async()=>{},updateTrack:async()=>{}};
 const run=await F.runFloorPicks(deps,{redis:fakeRedis(),dateKey,slotKey:'repair',slotTime:'07:00',manualTest:true});
 assert.equal(run.ticketsSent,1);assert.equal(codes.length,1);
 assert.ok(booked[0].length>16&&booked[0].length<30);
 assert.ok(booked[0].reduce((n,c)=>n*c.odds,1)>1000);
 assert.equal(new Set(booked.map(ticketSignature)).size,1);
});
