'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PLANS,buildPack,typeKey,pairKey,sameDay,runFloorPicks}=require('../lib/telegramFloorPicks');
const now=new Date('2026-10-13T06:00:00Z');
function pool(){const rows=[];for(const sport of ['football','tennis','basketball','hockey','handball','volleyball'])for(let m=0;m<9;m++)for(let e=0;e<55;e++)rows.push({eventId:sport+e,marketId:sport+m,outcomeId:'1',betType:m===0?(sport==='football'?'home_win':sport+'_winner'):sport==='basketball'&&m===1?'basketball_first_half_under':sport+'type'+m,winnerGapQualified:m===0,winnerGapMaxOneQualified:true,sport,probability:95-m*4,odds:1.2,kickoffUtc:'2026-10-13T12:00:00Z'});for(const type of ["oneup","dc_under45","home_away_under45","first5_goals_under05","over05","over15","corners_under115","corners_under125","goalkicks_under155","goalkicks_under165","streak_3_no","under45","shots_target_under135","shots_target_under125","shots_target_over45"])for(let e=0;e<40;e++)rows.push({eventId:(type==='shots_target_over45'?'specialover':'special')+e,marketId:type,outcomeId:type==='oneup'?"1":"13",betType:type,sport:"football",winnerGapBelowOneQualified:true,winnerGapMaxOneQualified:type!=='shots_target_over45',winnerGapAboveEightQualified:type==='shots_target_over45',probability:80,odds:1.3,kickoffUtc:"2026-10-13T12:00:00Z"});return rows;}
test('10 plans retain floors and unique matches after catalogue revision',()=>{const pack=buildPack(pool(),{now});assert.equal(pack.plans.length,10);for(const p of pack.plans.filter(p=>p.floor>0)){assert.equal(p.floor,p.targetOdds?60:70);assert.ok(p.selections.length>0&&p.selections.length<=p.maxGames);assert.equal(new Set(p.selections.map(c=>c.eventId)).size,p.selections.length);if(p.targetOdds)assert.ok(p.selections.reduce((n,c)=>n*c.odds,1)>=3);for(const c of p.selections){assert.ok(c.probability>=70);if(p.sport)assert.equal(c.sport,p.sport);if(p.winnerGapOnly)assert.equal(c.winnerGapQualified,true);}}});
test('gap qualification is exclusive to winner ticket and long shots rank odds first',()=>{const rows=pool().map((c,i)=>({...c,winnerGapQualified:false,odds:1.01+i/10000}));const p=buildPack(rows,{now}).plans;assert.equal(p.some(p=>p.winnerGapOnly),false);const long=p.find(x=>x.id==='footballWinnersHalf70');assert.equal(long.selections.length,20);assert.ok(long.selections[0].odds>=long.selections.at(-1).odds);});
test('evening excludes morning match/type pairs even at 95 percent',()=>{const am=buildPack(pool(),{now});const excluded=new Set(am.plans.flatMap(p=>p.selections.map(pairKey)));const pm=buildPack(pool().map(c=>({...c,kickoffUtc:'2026-10-13T17:10:00Z'})),{now:new Date('2026-10-13T17:00:00Z'),excluded});for(const p of pm.plans)for(const c of p.selections)assert.ok(!excluded.has(pairKey(c)));});
test('late tennis, live, started, next-day and invalid end times are excluded',()=>{const c={...pool().find(c=>c.betType==='streak_3_no'),kickoffUtc:'2026-10-13T20:00:00Z'};assert.equal(sameDay(c,now,'2026-10-13'),false);assert.equal(sameDay({...c,kickoffUtc:'2026-10-13T12:00:00Z'},now,'2026-10-13'),true);for(const change of [{live:true},{kickoffUtc:'2026-10-13T05:00:00Z'},{kickoffUtc:'2026-10-14T12:00:00Z'},{scheduledEndUtc:'bad'}])assert.equal(sameDay({...c,...change},now,'2026-10-13'),false);});
function redis(){const values=new Map(),hashes=new Map();return {get:async k=>values.get(k),set:async(k,v)=>{values.set(k,v);return 'OK';},hVals:async k=>[...(hashes.get(k)?.values()||[])],hSet:async(k,f,v)=>{if(!hashes.has(k))hashes.set(k,new Map());hashes.get(k).set(f,v);},expire:async()=>1};}
test('persistent checkpoints avoid duplicate sends after restart and save every code',async()=>{const r=redis(),codes=[],sent=[];let books=0;const deps={now:()=>now,loadPool:async()=>pool().map(c=>({...c,kickoffUtc:'2026-10-13T12:00:00Z'})),validate:async x=>x,book:async()=>({shareCode:'CODE'+(++books),shareURL:'https://example.test/booking/'+books}),saveCode:async(r,d,c)=>codes.push(c),track:async()=>{},updateTrack:async()=>{},send:async t=>sent.push(t)};const ctx={redis:r,dateKey:'2026-10-13',slotKey:'2026-10-13T07:00',slotTime:'07:00'};const a=await runFloorPicks(deps,ctx);assert.equal(a.ticketsSent,7);assert.equal(codes.length,7);assert.ok(sent.filter(t=>!t.includes("no qualifying variation")&&!t.includes("No distinct slip")).every(t=>t.includes("https://example.test/booking/")));await runFloorPicks(deps,ctx);assert.equal(books,7);assert.equal(sent.length,10);});
test('ambiguous booking reserves selections and cannot be booked again',async()=>{const r=redis();let books=0;const deps={now:()=>now,loadPool:async()=>pool().filter(c=>c.sport==='football'),validate:async x=>x,book:async()=>{books++;throw Error('timeout');},send:async()=>{},saveCode:async()=>{},track:async()=>{},updateTrack:async()=>{}};const ctx={redis:r,dateKey:'2026-10-13',slotKey:'2026-10-13T07:00',slotTime:'07:00'};await runFloorPicks(deps,ctx);const attempted=books;assert.ok(attempted>0);await runFloorPicks(deps,ctx);assert.equal(books,attempted);assert.ok((await r.hVals('telegram:floor:used:2026-10-13')).length);});
test('daily winner plans accept any future fixture returned by the source',()=>{
 const {eligible}=require('../lib/telegramFloorPicks');const c={...pool()[0],kickoffUtc:'2026-10-25T12:00:00Z'};
 const plan=PLANS.find(p=>p.id==='footballWinnersHalf70');
 assert.equal(eligible(c,plan,now,'2026-10-13',new Set()),true);
 assert.equal(eligible({...c,live:true},plan,now,'2026-10-13',new Set()),false);
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
 const a=await runFloorPicks(deps,{...base,slotKey:'manual-A'});assert.equal(a.ticketsSent,1);
 await runFloorPicks(deps,{...base,slotKey:'manual-A'});assert.equal(books,1);
 const b=await runFloorPicks(deps,{...base,slotKey:'manual-B'});assert.equal(b.ticketsSent,1);assert.equal(books,2);
 assert.equal((await r.hVals('telegram:floor:used:2026-10-13')).length,1);assert.equal(codes.length,2);
 assert.ok(sent.some(t=>t.includes('MANUAL TEST')));
});

test('validation top-ups use tomorrow after a current selection becomes ineligible',async()=>{
 const r=redis(),booked=[];const rows=Array.from({length:22},(_,i)=>({...pool()[0],eventId:'topup'+i,kickoffUtc:i<20?'2026-10-13T12:00:00Z':'2026-10-14T12:00:00Z'}));
 const deps={now:()=>now,loadPool:async()=>rows,validate:async x=>x.filter(c=>c.eventId!=='topup0'),book:async x=>{booked.push(x);return{shareCode:'TOP'+booked.length}},saveCode:async()=>{},track:async()=>{},updateTrack:async()=>{},send:async()=>{}};
 await runFloorPicks(deps,{redis:r,dateKey:'2026-10-13',slotKey:'topup-test',slotTime:'07:00'});assert.ok(booked.some(x=>x.length===20));assert.ok(booked.some(x=>x.some(c=>c.kickoffUtc.startsWith('2026-10-14'))));
});

test('removed first-five and retired daily plans stay out of the catalogue',()=>{
 const rows=pool().map(c=>c.betType==='first5_goals_under05'?{...c,probability:35,winnerGapMaxOneQualified:false}:c);
 const plans=buildPack(rows,{now}).plans;
 assert.ok(plans.filter(p=>p.longShot).every(p=>p.maxGames<=20&&p.selections.length<=p.maxGames));
 assert.ok(!plans.some(p=>['home_away_under4570target3','hockeyHighestUnder70long'].includes(p.id)));
 const first=plans.find(p=>p.id==='footballFirst5Under05');
 assert.equal(first,undefined);
});
test('cached 50-game plans migrate to 20 while completed checkpoints prevent a second booking',async()=>{
 const r=redis(),slot='migration';const old=buildPack(pool(),{now});old.plans=old.plans.filter(p=>!p.betTypes);for(const p of old.plans)if(p.longShot){p.maxGames=50;p.label='OLD 50';p.selections=pool().filter(c=>c.sport===p.sport).filter((c,i,a)=>a.findIndex(x=>x.eventId===c.eventId)===i).slice(0,50);}
 await r.set('telegram:floor:v3:pack:'+slot,JSON.stringify(old));await r.hSet('telegram:floor:v3:state:'+slot,'footballWinnersHalf70',JSON.stringify({id:'footballWinnersHalf70',status:'completed'}));
 const booked=[],deps={now:()=>now,loadPool:async()=>pool(),validate:async x=>x,book:async x=>{booked.push(x);return {shareCode:'M'+booked.length}},saveCode:async()=>{},track:async()=>{},updateTrack:async()=>{},send:async()=>{}};
 const result=await runFloorPicks(deps,{redis:r,dateKey:'2026-10-13',slotKey:slot,slotTime:'07:00',manualTest:true});assert.equal(result.ticketsSent,6);assert.ok(result.results.some(x=>x.id==='footballWinnersHalf70'&&x.reason==='completed'));assert.ok(booked.every(x=>x.length<=30));
});

test('every automatic Telegram plan excludes generic, named and Asian handicaps before selection',()=>{
 const {isHandicap}=require('../lib/telegramPickMarkets');
 const base=pool()[0],bad=[{betType:'ah_0'},{betType:'ah_extended'},{betType:'basketball_handicap_home'},{betType:'offered:900',marketDesc:'European Handicap'},{betType:'offered:901',marketDesc:'Point Spread'},{betType:'offered:16',marketId:'16'},{betType:'offered:902',specifier:'hcp=-2.5'}].map((c,i)=>({...base,...c,eventId:'bad'+i,probability:99,odds:100}));
 assert.ok(bad.every(isHandicap));const result=buildPack([...bad,...pool()],{now});assert.ok(result.plans.every(p=>p.selections.every(c=>!isHandicap(c))));assert.equal(isHandicap({...base,betType:'dnb',marketId:'11',marketDesc:'Draw No Bet'}),false);
});
test('cached unbooked handicaps are rejected again and replaced with eligible alternatives',async()=>{
 const r=redis(),slot='handicap-migration',pack=buildPack(pool(),{now}),plan=pack.plans.find(p=>p.id==='footballWinnersHalf70');
 const handicap={...plan.selections[0],betType:'offered:16',marketId:'16',marketDesc:'Asian Handicap',specifier:'hcp=0'};
 plan.selections[0]=handicap;await r.set('telegram:floor:v3:pack:'+slot,JSON.stringify(pack));
 const booked=[],deps={now:()=>now,loadPool:async()=>assert.fail('cached plans'),validate:async x=>x,book:async x=>{booked.push(x);return{shareCode:'HC'+booked.length}},saveCode:async()=>{},track:async()=>{},updateTrack:async()=>{},send:async()=>{}};
 await runFloorPicks(deps,{redis:r,dateKey:'2026-10-13',slotKey:slot,slotTime:'07:00'});assert.ok(booked.some(x=>x.length===20));assert.ok(booked.every(rows=>rows.every(c=>!require('../lib/telegramPickMarkets').isHandicap(c))));
});
test('retired daily tickets are gone; football accepts first-half match unders at 2.5 or higher',()=>{
 const plan=PLANS.find(p=>p.id==='footballWinnersHalf70');
 const base={...pool()[0],marketId:'68',outcomeId:'13',marketDesc:'1st Half - Over/Under',betType:'period_goals_first_half_match_under',odds:2};
 const rows=['2.5','3.5','1.5'].map((line,i)=>({...base,eventId:'half'+i,specifier:'total='+line}));
 assert.deepEqual(buildPack(rows,{now,plans:[plan]}).plans[0].selections.map(c=>c.eventId),['half0','half1']);
 assert.ok(!PLANS.some(p=>/streak3no|footballMulti|footballU45/.test(p.id)));
});
test('daily high-odds tiers book one unique slip each within their game cap',async()=>{
 const {DAILY_HIGH_ODDS}=require('../lib/telegramFloorPicks');
 const sig=require('../lib/telegramNext12h').ticketSignature;
 const rows=Array.from({length:30},(_,i)=>({eventId:'high'+i,marketId:'1',outcomeId:'1',betType:'home_win',sport:'football',
   probability:86-i*.7,qualityScore:80,edge:0,odds:i%3===0?2.25:2,kickoffUtc:new Date(+now+(90+i*6)*60000).toISOString()}));
 const booked=[],messages=[];
 const deps={plans:DAILY_HIGH_ODDS,now:()=>now,loadPool:async()=>rows,validate:async x=>x,book:async x=>{booked.push(x);return{shareCode:'H'+booked.length}},saveCode:async()=>{},track:async()=>{},updateTrack:async()=>{},send:async x=>messages.push(x)};
 const result=await runFloorPicks(deps,{redis:redis(),dateKey:'2026-10-13',slotKey:'high-test',slotTime:'07:00'});
 assert.equal(result.ticketsSent,3);
 assert.equal(new Set(booked.map(sig)).size,3);
 for(const [i,p] of DAILY_HIGH_ODDS.entries()){
  assert.ok(booked[i].length<=p.maxGames);
  assert.ok(booked[i].every((c,j,a)=>!j||a[j-1].kickoffUtc<=c.kickoffUtc));
  assert.ok(result.results[i].combinedOdds>=p.targetOdds);
  assert.match(messages[i],/Kickoff order/);
 }
});

test('short daily tiers use the closest qualifying fallback and accept exactly 1,000x',()=>{
 const {DAILY_HIGH_ODDS}=require('../lib/telegramFloorPicks');
 const p=DAILY_HIGH_ODDS.find(x=>x.targetOdds===10000);
 const rows=Array.from({length:10},(_,i)=>({eventId:'exact'+i,marketId:'1',outcomeId:'1',betType:'home_win',sport:'football',probability:67,odds:i===9?1.953125:2,kickoffUtc:'2026-10-13T12:00:00Z'}));
 const one=buildPack(rows,{now,plans:[p]}).plans[0];
 assert.equal(one.selections.reduce((n,c)=>n*c.odds,1),1000);
 assert.equal(buildPack(rows.slice(1),{now,plans:[p]}).plans[0].selections.length,0);
 const more=[...rows,{...rows[0],eventId:'extra',odds:2}];
 assert.equal(buildPack(more,{now,plans:[p]}).plans[0].selections.reduce((n,c)=>n*c.odds,1),2000);
});

test('new winner tickets enforce sport, floor and odds ranking',()=>{
 const plans=PLANS.filter(p=>p.highestOdds);
 const rows=pool().map((c,i)=>({...c,odds:1.1+i/10000}));
 for(const p of buildPack(rows,{now,plans}).plans){
  assert.equal(p.selections.length,20);
  assert.ok(p.selections.every((c,i,a)=>p.betTypes.includes(c.betType)&&c.probability>=70&&(!i||a[i-1].odds>=c.odds)));
 }
});
test('late daily high odds can use tomorrow without admitting games that finish after tomorrow',()=>{
 const {DAILY_HIGH_ODDS,highOddsCapacity}=require('../lib/telegramFloorPicks');
 const p=DAILY_HIGH_ODDS.find(p=>p.targetOdds===1000);
 const options={now:new Date('2026-10-13T21:00:00Z'),dateKey:'2026-10-13'};
 const rows=Array.from({length:10},(_,i)=>({eventId:'next'+i,marketId:'1',outcomeId:'1',betType:'home_win',sport:'football',odds:2,probability:66,kickoffUtc:'2026-10-14T12:00:00Z'}));
 rows.push({...rows[0],eventId:'too-late',scheduledEndUtc:'2026-10-14T23:00:00Z'});
 assert.deepEqual(highOddsCapacity(rows,p,options),{fixtures:10,maxOdds:1024});
 const [pick]=buildPack(rows,{...options,plans:[p]}).plans;
 assert.equal(pick.selections.length,10);
 assert.equal(pick.capacity.sourceRows,11);
 assert.equal(highOddsCapacity(rows,PLANS.find(p=>p.id==='today10k1'),options).fixtures,0);
});
