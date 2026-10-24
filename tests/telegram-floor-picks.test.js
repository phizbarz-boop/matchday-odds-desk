'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PLANS,buildPack,typeKey,pairKey,sameDay,runFloorPicks}=require('../lib/telegramFloorPicks');
const now=new Date('2026-10-13T06:00:00Z');
function pool(){const rows=[];for(const sport of ['football','tennis','basketball','hockey','handball','volleyball'])for(let m=0;m<9;m++)for(let e=0;e<55;e++)rows.push({eventId:sport+e,marketId:sport+m,outcomeId:'1',betType:m===0?(sport==='football'?'home_win':sport+'_winner'):sport+'type'+m,winnerGapQualified:m===0,winnerGapMaxOneQualified:true,sport,probability:95-m*4,odds:1.2,kickoffUtc:'2026-10-13T12:00:00Z'});for(const type of ["corners_under115","corners_under125","goalkicks_under155","goalkicks_under165","streak_3_no","under45","shots_target_under135","shots_target_under125","shots_target_over45"])for(let e=0;e<40;e++)rows.push({eventId:(type==='shots_target_over45'?'specialover':'special')+e,marketId:type,outcomeId:"13",betType:type,sport:"football",winnerGapMaxOneQualified:type!=='shots_target_over45',winnerGapAboveEightQualified:type==='shots_target_over45',probability:80,odds:1.2,kickoffUtc:"2026-10-13T12:00:00Z"});return rows;}
test('27 plans: sport tickets, gap winners, corners and separate goal-kicks, all floor 70',()=>{const pack=buildPack(pool(),{now});assert.equal(pack.plans.length,27);for(const p of pack.plans){assert.equal(p.floor,70);assert.equal(p.selections.length,p.maxGames);assert.equal(new Set(p.selections.map(c=>c.eventId)).size,p.maxGames);for(const c of p.selections){assert.ok(c.probability>=70);if(p.sport)assert.equal(c.sport,p.sport);if(p.winnerGapOnly)assert.equal(c.winnerGapQualified,true);}}});
test('gap qualification is exclusive to winner ticket and long shots rank odds first',()=>{const rows=pool().map((c,i)=>({...c,winnerGapQualified:false,odds:1.01+i/10000}));const p=buildPack(rows,{now}).plans;assert.equal(p.find(p=>p.winnerGapOnly).selections.length,0);assert.equal(p[0].selections.length,10);assert.equal(p[1].selections.length,30);assert.ok(p[1].selections[0].odds>p[0].selections[0].odds);});
test('evening excludes morning match/type pairs even at 95 percent',()=>{const am=buildPack(pool(),{now});const excluded=new Set(am.plans.flatMap(p=>p.selections.map(pairKey)));const pm=buildPack(pool().map(c=>({...c,kickoffUtc:'2026-10-13T17:10:00Z'})),{now:new Date('2026-10-13T17:00:00Z'),excluded});for(const p of pm.plans)for(const c of p.selections)assert.ok(!excluded.has(pairKey(c)));});
test('late tennis, live, started, next-day and invalid end times are excluded',()=>{const c={...pool().find(c=>c.sport==='tennis'),kickoffUtc:'2026-10-13T20:00:00Z'};assert.equal(sameDay(c,now,'2026-10-13'),false);assert.equal(sameDay({...c,kickoffUtc:'2026-10-13T12:00:00Z'},now,'2026-10-13'),true);for(const change of [{live:true},{kickoffUtc:'2026-10-13T05:00:00Z'},{kickoffUtc:'2026-10-14T12:00:00Z'},{scheduledEndUtc:'bad'}])assert.equal(sameDay({...c,...change},now,'2026-10-13'),false);});
function redis(){const values=new Map(),hashes=new Map();return {get:async k=>values.get(k),set:async(k,v)=>{values.set(k,v);return 'OK';},hVals:async k=>[...(hashes.get(k)?.values()||[])],hSet:async(k,f,v)=>{if(!hashes.has(k))hashes.set(k,new Map());hashes.get(k).set(f,v);},expire:async()=>1};}
test('persistent checkpoints avoid duplicate sends after restart and save every code',async()=>{const r=redis(),codes=[],sent=[];let books=0;const deps={now:()=>now,loadPool:async()=>pool().map(c=>({...c,kickoffUtc:'2026-10-13T12:00:00Z'})),validate:async x=>x,book:async()=>({shareCode:'CODE'+(++books),shareURL:'https://example.test/booking/'+books}),saveCode:async(r,d,c)=>codes.push(c),track:async()=>{},updateTrack:async()=>{},send:async t=>sent.push(t)};const ctx={redis:r,dateKey:'2026-10-13',slotKey:'2026-10-13T07:00',slotTime:'07:00'};const a=await runFloorPicks(deps,ctx);assert.equal(a.ticketsSent,27);assert.equal(codes.length,27);assert.ok(sent.every(t=>t.includes("https://example.test/booking/")));await runFloorPicks(deps,ctx);assert.equal(books,27);assert.equal(sent.length,27);});
test('ambiguous booking reserves selections and cannot be booked again',async()=>{const r=redis();let books=0;const deps={now:()=>now,loadPool:async()=>pool().filter(c=>c.sport==='football'),validate:async x=>x,book:async()=>{books++;throw Error('timeout');},send:async()=>{},saveCode:async()=>{},track:async()=>{},updateTrack:async()=>{}};const ctx={redis:r,dateKey:'2026-10-13',slotKey:'2026-10-13T07:00',slotTime:'07:00'};await runFloorPicks(deps,ctx);await runFloorPicks(deps,ctx);assert.equal(books,17);assert.ok((await r.hVals('telegram:floor:used:2026-10-13')).length);});
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

test('dedicated daily plans contain only their requested corner/goal-kick lines and long shots cap at 30',()=>{
 const plans=buildPack(pool(),{now}).plans;
 assert.ok(plans.filter(p=>p.longShot).every(p=>p.maxGames<=30&&p.selections.length<=p.maxGames));
 for(const id of ['corners70short','corners70long','goalkicks15570short','goalkicks16570short']){const p=plans.find(p=>p.id===id);assert.equal(p.selections.length,p.maxGames);assert.ok(p.selections.every(c=>p.betTypes.includes(c.betType)));assert.equal(p.floor,70);}
});
test('cached 50-game plans migrate to 30 while completed checkpoints prevent a second booking',async()=>{
 const r=redis(),slot='migration';const old=buildPack(pool(),{now});old.plans=old.plans.filter(p=>!p.betTypes);for(const p of old.plans)if(p.longShot){p.maxGames=50;p.label='OLD 50';p.selections=pool().filter(c=>c.sport===p.sport).filter((c,i,a)=>a.findIndex(x=>x.eventId===c.eventId)===i).slice(0,50);}
 await r.set('telegram:floor:v3:pack:'+slot,JSON.stringify(old));await r.hSet('telegram:floor:v3:state:'+slot,'football70short',JSON.stringify({id:'football70short',status:'completed'}));
 const booked=[],deps={now:()=>now,loadPool:async()=>pool(),validate:async x=>x,book:async x=>{booked.push(x);return {shareCode:'M'+booked.length}},saveCode:async()=>{},track:async()=>{},updateTrack:async()=>{},send:async()=>{}};
 const result=await runFloorPicks(deps,{redis:r,dateKey:'2026-10-13',slotKey:slot,slotTime:'07:00',manualTest:true});assert.equal(result.ticketsSent,26);assert.ok(result.results.some(x=>x.id==='football70short'&&x.reason==='completed'));assert.ok(booked.every(x=>x.length<=30));assert.ok(result.results.some(x=>x.id==='corners70long'&&x.sent));
});

test('every automatic Telegram plan excludes generic, named and Asian handicaps before selection',()=>{
 const {isHandicap}=require('../lib/telegramPickMarkets');
 const base=pool()[0],bad=[{betType:'ah_0'},{betType:'ah_extended'},{betType:'basketball_handicap_home'},{betType:'offered:900',marketDesc:'European Handicap'},{betType:'offered:901',marketDesc:'Point Spread'},{betType:'offered:16',marketId:'16'},{betType:'offered:902',specifier:'hcp=-2.5'}].map((c,i)=>({...base,...c,eventId:'bad'+i,probability:99,odds:100}));
 assert.ok(bad.every(isHandicap));const result=buildPack([...bad,...pool()],{now});assert.ok(result.plans.every(p=>p.selections.every(c=>!isHandicap(c))));assert.equal(isHandicap({...base,betType:'dnb',marketId:'11',marketDesc:'Draw No Bet'}),false);
});
test('cached unbooked handicaps are rejected again and replaced with eligible alternatives',async()=>{
 const r=redis(),slot='handicap-migration',pack=buildPack(pool(),{now}),plan=pack.plans[0];
 const handicap={...plan.selections[0],betType:'offered:16',marketId:'16',marketDesc:'Asian Handicap',specifier:'hcp=0'};
 plan.selections[0]=handicap;await r.set('telegram:floor:v3:pack:'+slot,JSON.stringify(pack));
 const booked=[],deps={now:()=>now,loadPool:async()=>assert.fail('cached plans'),validate:async x=>x,book:async x=>{booked.push(x);return{shareCode:'HC'+booked.length}},saveCode:async()=>{},track:async()=>{},updateTrack:async()=>{},send:async()=>{}};
 await runFloorPicks(deps,{redis:r,dateKey:'2026-10-13',slotKey:slot,slotTime:'07:00'});assert.equal(booked[0].length,10);assert.ok(booked.every(rows=>rows.every(c=>!require('../lib/telegramPickMarkets').isHandicap(c))));
});
test('new goal-streak tickets contain only No selections with a 70 percent floor and 10/30 limits',()=>{
 const plans=buildPack([...pool(),{...pool()[0],eventId:'streak-yes',betType:'streak_3_yes',probability:99}],{now}).plans.filter(p=>p.id.startsWith('streak3no'));
 assert.equal(plans.length,2);assert.deepEqual(plans.map(p=>p.selections.length),[10,30]);for(const p of plans){assert.equal(p.floor,70);assert.ok(p.selections.every(c=>c.betType==='streak_3_no'&&c.probability>=70));}
});
