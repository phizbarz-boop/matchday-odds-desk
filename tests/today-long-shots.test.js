'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../lib/telegramFloorPicks'),T=require('../lib/todayLongShots');
const {ticketSignature}=require('../lib/telegramNext12h');
const now=new Date('2026-11-05T06:00:00Z'),dateKey='2026-11-05';
const pool=Array.from({length:36},(_,i)=>({eventId:'E'+i,marketId:'1',outcomeId:'1',betType:'home_win',sport:i%2?'Football':'Basketball',kickoffUtc:new Date(+now+(60+i*10)*60000).toISOString(),odds:1.4,probability:65-i/2,home:'Home '+i,away:'Away '+i}));
test('three distinct 30-game tickets meet target and use today WAT only without a probability floor',()=>{
 const rows=[...pool,{...pool[0],eventId:'tomorrow',kickoffUtc:'2026-11-05T23:00:00Z',probability:99},{...pool[0],eventId:'unknown',probability:null},{...pool[0],eventId:'live',live:true,probability:99}];
 const {plans}=F.buildPack(rows,{now,dateKey,plans:T.PLANS});assert.equal(new Set(plans.map(p=>ticketSignature(p.selections))).size,3);
 for(const p of plans){assert.equal(p.selections.length,30);assert.equal(new Set(p.selections.map(c=>c.eventId)).size,30);assert.ok(p.selections.reduce((n,c)=>n*c.odds,1)>=10000);assert.ok(p.selections.every(c=>pool.includes(c)));assert.ok(p.selections.every((c,i)=>!i||c.kickoffUtc>=p.selections[i-1].kickoffUtc));}
 assert.equal(F.buildPack(pool.slice(0,29),{now,dateKey,plans:T.PLANS}).plans[0].selections.length,29);
});
test('daily workflow saves all three confirmed codes and allows repricing above 1,000 and rejects lower odds',async()=>{
 const {fakeRedis}=require('./fixtures/fake-redis');const codes=[],messages=[];let books=0;
 const deps={plans:T.PLANS,now:()=>now,loadPool:async()=>pool,validate:async x=>x,book:async()=>({shareCode:'TODAY'+(++books)}),saveCode:async(_r,_d,c)=>codes.push(c),send:async t=>messages.push(t),track:async()=>{},updateTrack:async()=>{}};
 const ctx={redis:fakeRedis(),dateKey,slotKey:'test',slotTime:'07:00',manualTest:true};
 const run=await F.runFloorPicks(deps,ctx);assert.equal(run.ticketsSent,3);assert.equal(codes.length,3);assert.ok(messages.every(t=>t.includes('30 games')&&t.includes('Kickoff order')&&t.length<4096));
 assert.equal(require('../lib/telegramCodeSession').currentCodes(codes,new Date('2026-11-05T19:00:00Z')).length,3);
 deps.validate=async rows=>rows.map(c=>({...c,odds:1.3}));await F.runFloorPicks(deps,{...ctx,slotKey:'fallback'});assert.equal(books,6);assert.ok(messages.slice(3).every(t=>t.includes('(fallback)')));
 deps.validate=async rows=>rows.map(c=>({...c,odds:1.01}));await F.runFloorPicks(deps,{...ctx,slotKey:'reprice'});assert.equal(books,6);
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
