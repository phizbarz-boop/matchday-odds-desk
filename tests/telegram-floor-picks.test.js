'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PLANS,buildPack,typeKey,pairKey,sameDay,runFloorPicks}=require('../lib/telegramFloorPicks');
const now=new Date('2026-10-13T06:00:00Z');
function pool(){const rows=[];for(const sport of ['football','tennis','basketball','hockey','handball','volleyball'])for(let m=0;m<9;m++)for(let e=0;e<55;e++)rows.push({eventId:sport+e,marketId:sport+m,outcomeId:'1',betType:m===0?(sport==='football'?'home_win':sport+'_winner'):sport+'type'+m,winnerGapQualified:m===0,sport,probability:95-m*4,odds:1.2,kickoffUtc:'2026-10-13T12:00:00Z'});return rows;}
test('13 plans: each sport short and long plus gap winners, all floor 70',()=>{const pack=buildPack(pool(),{now});assert.equal(pack.plans.length,13);for(const p of pack.plans){assert.equal(p.floor,70);assert.equal(p.selections.length,p.maxGames);assert.equal(new Set(p.selections.map(c=>c.eventId)).size,p.maxGames);for(const c of p.selections){assert.ok(c.probability>=70);if(p.sport)assert.equal(c.sport,p.sport);if(p.winnerGapOnly)assert.equal(c.winnerGapQualified,true);}}});
test('gap qualification is exclusive to winner ticket and long shots rank odds first',()=>{const rows=pool().map((c,i)=>({...c,winnerGapQualified:false,odds:1.01+i/10000}));const p=buildPack(rows,{now}).plans;assert.equal(p.at(-1).selections.length,0);assert.equal(p[0].selections.length,10);assert.equal(p[1].selections.length,50);assert.ok(p[1].selections[0].odds>p[0].selections[0].odds);});
test('evening excludes morning match/type pairs even at 95 percent',()=>{const am=buildPack(pool(),{now});const excluded=new Set(am.plans.flatMap(p=>p.selections.map(pairKey)));const pm=buildPack(pool().map(c=>({...c,kickoffUtc:'2026-10-13T17:10:00Z'})),{now:new Date('2026-10-13T17:00:00Z'),excluded});for(const p of pm.plans)for(const c of p.selections)assert.ok(!excluded.has(pairKey(c)));});
test('late tennis, live, started, next-day and invalid end times are excluded',()=>{const c={...pool().find(c=>c.sport==='tennis'),kickoffUtc:'2026-10-13T20:00:00Z'};assert.equal(sameDay(c,now,'2026-10-13'),false);assert.equal(sameDay({...c,kickoffUtc:'2026-10-13T12:00:00Z'},now,'2026-10-13'),true);for(const change of [{live:true},{kickoffUtc:'2026-10-13T05:00:00Z'},{kickoffUtc:'2026-10-14T12:00:00Z'},{scheduledEndUtc:'bad'}])assert.equal(sameDay({...c,...change},now,'2026-10-13'),false);});
function redis(){const values=new Map(),hashes=new Map();return {get:async k=>values.get(k),set:async(k,v)=>{values.set(k,v);return 'OK';},hVals:async k=>[...(hashes.get(k)?.values()||[])],hSet:async(k,f,v)=>{if(!hashes.has(k))hashes.set(k,new Map());hashes.get(k).set(f,v);},expire:async()=>1};}
test('persistent checkpoints avoid duplicate sends after restart and save every code',async()=>{const r=redis(),codes=[],sent=[];let books=0;const deps={now:()=>now,loadPool:async()=>pool().map(c=>({...c,kickoffUtc:'2026-10-13T12:00:00Z'})),validate:async x=>x,book:async()=>({shareCode:'CODE'+(++books),shareURL:'https://example.test/booking/'+books}),saveCode:async(r,d,c)=>codes.push(c),track:async()=>{},updateTrack:async()=>{},send:async t=>sent.push(t)};const ctx={redis:r,dateKey:'2026-10-13',slotKey:'2026-10-13T07:00',slotTime:'07:00'};const a=await runFloorPicks(deps,ctx);assert.equal(a.ticketsSent,13);assert.equal(codes.length,13);assert.ok(sent.every(t=>t.includes("https://example.test/booking/")));await runFloorPicks(deps,ctx);assert.equal(books,13);assert.equal(sent.length,13);});
test('ambiguous booking reserves selections and cannot be booked again',async()=>{const r=redis();let books=0;const deps={now:()=>now,loadPool:async()=>pool().filter(c=>c.sport==='football'),validate:async x=>x,book:async()=>{books++;throw Error('timeout');},send:async()=>{},saveCode:async()=>{},track:async()=>{},updateTrack:async()=>{}};const ctx={redis:r,dateKey:'2026-10-13',slotKey:'2026-10-13T07:00',slotTime:'07:00'};await runFloorPicks(deps,ctx);await runFloorPicks(deps,ctx);assert.equal(books,3);assert.ok((await r.hVals('telegram:floor:used:2026-10-13')).length);});
test('long shots accept seven days and daily plans allow tomorrow fallback',()=>{
 const {withinWeek,eligible}=require('../lib/telegramFloorPicks');const c={...pool()[0],kickoffUtc:'2026-10-14T12:00:00Z'};
 assert.equal(eligible(c,PLANS[0],now,'2026-10-13',new Set()),true);
 assert.equal(eligible(c,PLANS[1],now,'2026-10-13',new Set()),true);
 assert.equal(withinWeek({...c,kickoffUtc:new Date(now.getTime()+7*86400000).toISOString()},now),true);
 assert.equal(withinWeek({...c,kickoffUtc:new Date(now.getTime()+7*86400000+1).toISOString()},now),false);
 assert.equal(withinWeek({...c,live:true},now),false);
});
test('manual run slots bypass schedule and differ per test ID while scheduled slots stay fixed',()=>{
 const {resolveFloorSlot}=require('../lib/telegramFloorPicks');const early=new Date('2026-10-13T01:00:00Z');
 assert.equal(resolveFloorSlot({},early),null);
 const a=resolveFloorSlot({'x-matchday-run-mode':'manual','x-matchday-run-id':'test-1'},early),b=resolveFloorSlot({'x-matchday-run-mode':'manual','x-matchday-run-id':'test-2'},early);
 assert.equal(a.manualTest,true);assert.notEqual(a.slotKey,b.slotKey);
 assert.throws(()=>resolveFloorSlot({'x-matchday-run-mode':'manual'},early));
 assert.equal(resolveFloorSlot({},now).slotKey,'2026-10-13T07:00');
});
test('partial tickets book and separate manual tests repeat games without changing scheduled reservations',async()=>{
 const r=redis(),sent=[],codes=[];let books=0;const c=pool()[0];
 await r.hSet('telegram:floor:used:2026-10-13','morning',JSON.stringify([pairKey(c)]));
 const deps={now:()=>now,loadPool:async()=>[c],validate:async x=>x,book:async()=>({shareCode:'T'+(++books)}),saveCode:async(r,d,c)=>codes.push(c),track:async()=>{},updateTrack:async()=>{},send:async t=>sent.push(t)};
 const base={redis:r,dateKey:'2026-10-13',slotTime:'07:00',manualTest:true};
 const a=await runFloorPicks(deps,{...base,slotKey:'manual-A'});assert.equal(a.ticketsSent,3);
 await runFloorPicks(deps,{...base,slotKey:'manual-A'});assert.equal(books,3);
 const b=await runFloorPicks(deps,{...base,slotKey:'manual-B'});assert.equal(b.ticketsSent,3);assert.equal(books,6);
 assert.equal((await r.hVals('telegram:floor:used:2026-10-13')).length,1);assert.equal(codes.length,6);
 assert.ok(sent.some(t=>t.includes('MANUAL TEST')));
});

test('daily tickets choose today before tomorrow and exclude later days',()=>{
 const rows=Array.from({length:15},(_,i)=>({...pool()[0],eventId:'fallback'+i,probability:i<3?75:95,kickoffUtc:i<3?'2026-10-13T12:00:00Z':'2026-10-14T12:00:00Z'}));
 const plan=buildPack(rows,{now}).plans[0];assert.equal(plan.selections.length,10);assert.ok(plan.selections.slice(0,3).every(c=>c.kickoffUtc.startsWith('2026-10-13')));assert.ok(plan.selections.slice(3).every(c=>c.kickoffUtc.startsWith('2026-10-14')));
 const later={...rows[0],kickoffUtc:'2026-10-15T12:00:00Z'};assert.equal(require('../lib/telegramFloorPicks').eligible(later,PLANS[0],now,'2026-10-13',new Set()),false);
});

test('validation top-ups use tomorrow after a current selection becomes ineligible',async()=>{
 const r=redis(),booked=[];const rows=Array.from({length:12},(_,i)=>({...pool()[0],eventId:'topup'+i,kickoffUtc:i<10?'2026-10-13T12:00:00Z':'2026-10-14T12:00:00Z'}));
 const deps={now:()=>now,loadPool:async()=>rows,validate:async x=>x.filter(c=>c.eventId!=='topup0'),book:async x=>{booked.push(x);return{shareCode:'TOP'+booked.length}},saveCode:async()=>{},track:async()=>{},updateTrack:async()=>{},send:async()=>{}};
 await runFloorPicks(deps,{redis:r,dateKey:'2026-10-13',slotKey:'topup-test',slotTime:'07:00'});assert.equal(booked[0].length,10);assert.ok(booked[0].some(c=>c.kickoffUtc.startsWith('2026-10-14')));
});
