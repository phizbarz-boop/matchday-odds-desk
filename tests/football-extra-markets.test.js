'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),M=require('../lib/footballExtraMarkets');
const row=(name,side='Over',line=.5)=>({sport:'Football',eventId:'E',marketId:'900999',marketDesc:name,specifier:'total='+line,outcomeId:side==='Over'?'12':'13',outcomeDesc:side+' '+line,odds:side==='Over'?1.25:4.5});
test('exact home/away offsides and first-five-minute goals; other lines and scopes rejected',()=>{
 assert.equal(M.betTypeFor(row('Away Team Offsides')),M.IDS[0]);assert.equal(M.betTypeFor(row('Home Team - Offsides')),M.IDS[1]);assert.equal(M.betTypeFor(row('Total Goals Over/Under - 1-5 Minutes','Under')),M.IDS[2]);
 for(const c of [row('Total Goals Over/Under','Under'),row('Total Goals Over/Under - 6-10 Minutes','Under'),row('1st Half Away Team Offsides'),row('Away Team Offsides','Over',1.5),row('Total Goals Over/Under - 1-5 Minutes','Over'),{...row('Away Team Offsides'),live:true}])assert.equal(M.betTypeFor(c),null);
});
test('complete prices model the exact selection; missing opposite price is not scored',()=>{
 const {modelOfferedMarkets}=require('../lib/offeredMarketModel');for(const name of ['Away Team Offsides','Home Team Offsides','Total Goals Over/Under - 1-5 Minutes','Total Goals Over/Under - 1-10 Minutes','Total Goals Over/Under - 1-20 Minutes']){
 const rows=[row(name),row(name,'Under')],out=modelOfferedMarkets(rows,{minProbability:0,minEdge:-100}).candidates;
 const desired=out.find(c=>M.IDS.includes(c.betType));assert.ok(desired);assert.equal(desired.marketId,'900999');assert.equal(desired.specifier,'total=0.5');assert.ok(desired.probability>0&&desired.probability<100);assert.equal(desired.independentModel,false);
 assert.equal(modelOfferedMarkets([rows[0]],{minProbability:0,minEdge:-100}).candidates.length,0);
 }
});
test('website exposes all extra types and independent multi-league controls',()=>{const fs=require('node:fs'),s=fs.readFileSync(require.resolve('../public/index.html'),'utf8');for(const id of M.IDS)assert.ok(s.includes(id));assert.ok(s.includes('id="auto-league-list" multiple'));assert.ok(s.includes('auto-league-mode'));assert.ok(s.includes("fetch('/api/sportybet/leagues')"));});
test('specialty settlement never substitutes full-time goals for offsides or first-five-minute goals',()=>{const {settleSelection}=require('../lib/liveSettlement');for(const betType of M.IDS){const r=settleSelection({...row('Total Goals Over/Under - 1-5 Minutes','Under'),betType},{eventId:'E',matchStatus:'FT',homeScore:0,awayScore:0},null);assert.equal(r.status,'pending');}});
test('unselected new markets cannot leak into extra-market selections',()=>{const {expandedSelectionAllowed}=require('../lib/streakGoalModel');for(const betType of M.IDS){assert.equal(expandedSelectionAllowed({betType},['home_win'],true),false);assert.equal(expandedSelectionAllowed({betType},[betType],true),true);}});
test('compact report remains one message even for thousands of tickets',()=>{const {performanceText,buildPerformanceReport}=require('../lib/telegramPerformance');const tickets=Array.from({length:1000},(_,i)=>({shareCode:'C'+i,label:'L'.repeat(500),createdAt:'2026-11-01T07:00:00Z',status:'lost',lastStatusDetail:{returnMultiplier:0,complete:true,totalLegs:1,counts:{won:0,lost:1,push:0,half_won:0,half_lost:0},legDetails:[{home:'SECRET HOME',away:'SECRET AWAY',status:'lost',eventId:'E'+i,marketId:'1',outcomeId:'1',betType:'home_win',sport:'Football'}]}}));const text=performanceText(buildPerformanceReport(tickets,{start:'2026-11-01T00:00:00Z',end:'2026-11-01T12:00:00Z'}));assert.ok(text.length<=1800);assert.ok(!text.includes('SECRET'));assert.ok(text.includes('Tickets: 1000'));});
test('final candidate pipeline enforces one/multiple/all/empty leagues across sports',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../server'),'utf8'),start=source.indexOf('async function prepareAutoCandidatePool('),end=source.indexOf('\n}\n',start)+2;
 const rows=[{eventId:'A',sport:'Football',tournament:'League A',probability:80,odds:1.2},{eventId:'B',sport:'Basketball',tournament:'League B',probability:80,odds:1.2},{eventId:'C',sport:'Ice Hockey',tournament:'League C',probability:80,odds:1.2}];
 const context={normalizeSportScopes:()=>['football','basketball'],normalizeLiveMode:x=>x,loadAutoCandidates:async()=>rows,require:()=>({checkCandidates:async x=>x}),sportyRequest:()=>null,passesRedFlagFilter:()=>true};vm.createContext(context);vm.runInContext(source.slice(start,end)+';this.prepare=prepareAutoCandidatePool;',context);
 assert.equal((await context.prepare({leagues:null})).candidates.length,3);assert.deepEqual(Array.from((await context.prepare({leagues:['League B']})).candidates).map(c=>c.eventId),['B','C']);assert.equal((await context.prepare({leagues:['League A','League B']})).candidates.length,3);assert.equal((await context.prepare({leagues:[]})).candidates.length,1);
});

test('Telegram offers first-five Under 0.5 and parses the minimum leg odds and high target independently',()=>{
 const bot=require('../lib/telegramAiBot');
 const parsed=bot.parseNaturalRequest('Build a 100,000x football ticket: Total Goals Over/Under from 1 to 5 minutes Under 0.5, minimum odds per match 1.20');
 assert.deepEqual(parsed.betTypes,['first5_goals_under05']);
 assert.equal(parsed.targetOdds,100000);
 assert.equal(parsed.minMatchOdds,1.2);
 assert.equal(bot.parseNaturalRequest('100000x').targetOdds,100000);
 assert.ok(bot.allowedBetIdsForPlan('pro').includes('first5_goals_under05'));
 const target=bot.targetKeyboard({plan:'elite',planExpiresAt:'2099-01-01'}).inline_keyboard.flat().find(b=>b.text==='100,000x+');
 assert.equal(target.callback_data,'set:target:100000');
});

test('strict 100,000x builder rejects a near miss and finds a qualifying combination',()=>{
 const {selectAutoBet}=require('../lib/autoPicker');
 const fixtures=Array.from({length:17},(_,i)=>({eventId:String(i),odds:2,probability:70,qualityScore:80}));
 const settings={targetOdds:100000,maxSelections:17,trials:50,requireTarget:true};
 assert.equal(selectAutoBet(fixtures.slice(1),settings).selections.length,0);
 const reached=selectAutoBet(fixtures,settings);
 assert.equal(reached.reachedTarget,true);
 assert.ok(reached.combinedOdds>=100000);
});

test('the two new periods can be selected on demand and cannot enter automated daily slips',()=>{
 const bot=require('../lib/telegramAiBot'),daily=require('../lib/telegramFloorPicks');
 const now=new Date('2026-11-05T06:00:00Z');
 for(const n of [10,20]){
  const id='first'+n+'_goals_under05',label='Total Goals, Minutes 1–'+n;
  const c={...row(label,'Under'),betType:id,kickoffUtc:'2026-11-05T12:00:00Z',probability:92,odds:1.4};
  assert.equal(M.betTypeFor(c),id);
  assert.equal(M.betTypeFor(row(label,'Over')),null);
  assert.deepEqual(bot.parseNaturalRequest('build a football ticket: '+label+' — Under 0.5').betTypes,[id]);
  assert.ok(bot.allowedBetIdsForPlan('pro').includes(id));
  for(const plan of daily.PLANS)assert.equal(daily.eligible(c,plan,now,'2026-11-05',new Set()),false);
 }
});

test('100,000x fallback prefers the target, then the closest odds down to an inclusive 1,000x',()=>{
 const {selectAutoBet}=require('../lib/autoPicker');
 const odds=[999,1000,12000,95000,100001],fixtures=odds.map((odds,i)=>({eventId:String(i),odds,probability:i===2?95:60,qualityScore:80}));
 const settings={targetOdds:100000,maxSelections:1,trials:50,closestFallbackMin:1000};
 assert.equal(selectAutoBet(fixtures.slice(0,1),settings).selections.length,0);
 assert.equal(selectAutoBet(fixtures.slice(0,2),settings).combinedOdds,1000);
 const closest=selectAutoBet(fixtures.slice(0,4),settings);
 assert.equal(closest.combinedOdds,95000);
 assert.equal(closest.reachedTarget,false);
 assert.equal(selectAutoBet(fixtures,settings).reachedTarget,true);
});
