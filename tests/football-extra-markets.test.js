'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),M=require('../lib/footballExtraMarkets');
const row=(name,side='Over',line=.5)=>({sport:'Football',eventId:'E',marketId:'900999',marketDesc:name,specifier:'total='+line,outcomeId:side==='Over'?'12':'13',outcomeDesc:side+' '+line,odds:side==='Over'?1.25:4.5});
test('exact home/away offsides and first-five-minute goals; other lines and scopes rejected',()=>{
 assert.equal(M.betTypeFor(row('Away Team Offsides')),M.IDS[0]);assert.equal(M.betTypeFor(row('Home Team - Offsides')),M.IDS[1]);assert.equal(M.betTypeFor(row('Total Goals Over/Under - 1-5 Minutes','Under')),'first5_goals_under05');
 for(const c of [row('Total Goals Over/Under','Under'),row('Total Goals Over/Under - 6-10 Minutes','Under'),row('1st Half Away Team Offsides'),row('Away Team Offsides','Over',1.5),row('Total Goals Over/Under - 1-5 Minutes','Over'),{...row('Away Team Offsides'),live:true}])assert.equal(M.betTypeFor(c),null);
});
test('complete prices model the exact selection; missing opposite price is not scored',()=>{
 const {modelOfferedMarkets}=require('../lib/offeredMarketModel');for(const name of ['Away Team Offsides','Home Team Offsides','Total Goals Over/Under - 1-5 Minutes','Total Goals Over/Under - 1-10 Minutes','Total Goals Over/Under - 1-20 Minutes']){
 const rows=[row(name),row(name,'Under')],out=modelOfferedMarkets(rows,{minProbability:0,minEdge:-100}).candidates;
 const desired=out.find(c=>(M.IDS.includes(c.betType)||/^first(?:5|10|20)_goals_under05$/.test(c.betType)));assert.ok(desired);assert.equal(desired.marketId,'900999');assert.equal(desired.specifier,'total=0.5');assert.ok(desired.probability>0&&desired.probability<100);assert.equal(desired.independentModel,false);
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
 const context={normalizeSportScopes:()=>['football','basketball'],normalizeLiveMode:x=>x,loadAutoCandidates:async()=>rows,require:(name)=>name==='./lib/footballExtraMarkets'?M:({checkCandidates:async x=>x}),sportyRequest:()=>null,passesRedFlagFilter:()=>true};vm.createContext(context);vm.runInContext(source.slice(start,end)+';this.prepare=prepareAutoCandidatePool;',context);
 assert.equal((await context.prepare({leagues:null})).candidates.length,3);assert.deepEqual(Array.from((await context.prepare({leagues:['League B']})).candidates).map(c=>c.eventId),['B','C']);assert.equal((await context.prepare({leagues:['League A','League B']})).candidates.length,3);assert.equal((await context.prepare({leagues:[]})).candidates.length,1);
});

test('Telegram offers first-five Under 0.5 and parses the minimum leg odds and high target independently',()=>{
 const bot=require('../lib/telegramAiBot');
 const parsed=bot.parseNaturalRequest('Build a 100,000x football ticket: Total Goals Over/Under from 1 to 5 minutes Under 0.5, minimum odds per match 1.20');
 assert.ok(!parsed.betTypes?.includes('first5_goals_under05'));
 assert.equal(parsed.targetOdds,100000);
 assert.equal(parsed.minMatchOdds,1.2);
 assert.equal(bot.parseNaturalRequest('100000x').targetOdds,100000);
 assert.ok(!bot.allowedBetIdsForPlan('pro').includes('first5_goals_under05'));
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
  assert.ok(!bot.parseNaturalRequest('build a football ticket: '+label+' — Under 0.5').betTypes?.includes(id));
  assert.ok(!bot.allowedBetIdsForPlan('pro').includes(id));
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

test('football specialty picks map the exact line, team, period and outcome in both builders',()=>{
 const cases=[
  ['Player to Score','No','Yes',null,'player_not_to_score','player not to score'],
  ['Away Team Total Bookings','Over 0.5','Under 0.5',.5,'away_bookings_over05','away team total bookings over 0.5'],
  ['Sending Off','No','Yes',null,'sending_off_no','sending off no'],
  ['1st Half Substitutions','Under 0.5','Over 0.5',.5,'first_half_substitutions_under05','1st half substitution under 0.5'],
  ['Goal Scored by a Substitution','No','Yes',null,'substitute_goal_no','goal scored by a substitution no'],
  ['Total Offsides','Under 4.5','Over 4.5',4.5,'offsides_under45','offside under 4.5'],
  ['Total Offsides','Under 5.5','Over 5.5',5.5,'offsides_under55','offside under 5.5'],
  ['Away Team Post and Crossbar','Under 0.5','Over 0.5',.5,'away_woodwork_under05','away team post and crossbar under 0.5'],
 ];
 const bot=require('../lib/telegramAiBot'),{modelOfferedMarkets}=require('../lib/offeredMarketModel');
 for(const [marketDesc,side,opposite,line,id,request] of cases){
  const r={...row(marketDesc),outcomeDesc:side,specifier:line==null?'':'total='+line,odds:1.25};
  const other={...r,outcomeId:'other',outcomeDesc:opposite,odds:4.5};
  assert.equal(M.betTypeFor(r),id);
  assert.equal(M.betTypeFor(other),null);
  assert.equal(modelOfferedMarkets([r,other]).candidates.find(c=>c.betType===id)?.outcomeId,r.outcomeId);
  assert.equal(modelOfferedMarkets([r]).candidates.length,0);
  if(M.REMOVED_IDS.includes(id)){assert.ok(!bot.parseNaturalRequest('Build a ticket with '+request).betTypes?.includes(id));assert.ok(!bot.allowedBetIdsForPlan('pro').includes(id));}
  else {assert.deepEqual(bot.parseNaturalRequest('Build a ticket with '+request).betTypes,[id]);assert.ok(bot.allowedBetIdsForPlan('pro').includes(id));}
 }
 assert.ok(!bot.parseNaturalRequest('Build a ticket with offside under 4.5 - 5.5').betTypes?.some(id=>M.REMOVED_IDS.includes(id)));
 assert.equal(M.betTypeFor(row('Home Team Total Bookings')),null);
 assert.equal(M.betTypeFor(row('2nd Half Substitutions','Under')),null);
 assert.equal(M.betTypeFor(row('Away Team Offsides','Under',4.5)),null);
 assert.equal(M.betTypeFor(row('Total Offsides','Under',6.5)),null);
});

test('player totals use the exact half-goal selection and explicit negative lists use individual prices',()=>{
 const {modelOfferedMarkets}=require('../lib/offeredMarketModel');
 const total={...row('Player Goals Over/Under','Under'),playerName:'Example Player',specifier:'player=7|total=0.5'};
 const other={...total,outcomeId:'over',outcomeDesc:'Over 0.5',odds:1.25};
 const result=modelOfferedMarkets([total,other]);
 assert.ok(result.candidates.some(c=>c.betType==='player_not_to_score'));
 const diagnostics=M.playerDiagnostics([total,other],result.candidates);
 assert.equal(diagnostics.binary,1);
 assert.equal(diagnostics.modeled,1);
 assert.equal(M.betTypeFor({...total,marketDesc:'Away - Goals'}),null);
 assert.equal(M.betTypeFor({...total,marketDesc:'Example Player - Goals',playerName:null}),null);
 const list=[{...row('Player Not to Score'),outcomeDesc:'Player A',odds:1.1},{...row('Player Not to Score'),outcomeId:'B',outcomeDesc:'Player B',odds:1.2}];
 assert.equal(modelOfferedMarkets(list).candidates.length,2);assert.ok(modelOfferedMarkets(list).candidates.every(c=>c.modelBasis==='single_offered_price'&&!c.independentModel));
 assert.equal(M.playerDiagnostics(list).binary,0);
 assert.match(M.playerDiagnosticText(M.playerDiagnostics(list)),/Player A/);
 assert.equal(M.playerDiagnostics([]).marketInstances,0);
});

test('four new football options are scored and available to Telegram requests',()=>{
 const F=require('../lib/footballExtraMarkets'),T=require('../lib/telegramAiBot'),M=require('../lib/offeredMarketModel');
 const cases=[
  ['68','1st Half - Over/Under','2.5','Under','first half under 2.5','first_half_goals_under25'],
  ['90','2nd Half - Over/Under','0.5','Over','second half over 0.5','second_half_goals_over05'],
  ['off','Total Offsides - Over/Under','0.5','Over','offside over 0.5','offsides_over05'],
  ['book','Total Bookings - Over/Under','0.5','Over','booking over 0.5','bookings_over05']
 ];
 for(const [marketId,marketDesc,line,side,request,id] of cases){
  const rows=['Over','Under'].map((outcomeDesc,i)=>({eventId:'test',marketId,marketDesc,marketOutcomeCount:2,sport:'Football',specifier:'total='+line,outcomeDesc,outcomeId:String(12+i),odds:1.9}));
  assert.equal(F.betTypeFor(rows.find(c=>c.outcomeDesc===side)),id);
  assert.ok(M.modelOfferedMarkets(rows).candidates.some(c=>c.betType===id));
  assert.ok(T.ALL_BET_IDS.includes(id));
  assert.deepEqual(T.parseNaturalRequest('build ticket '+request).betTypes,[id]);
 }
});
test('retired markets are blocked by name or ID even when expanded markets are enabled',()=>{
 const F=require('../lib/footballExtraMarkets'),S=require('../lib/streakGoalModel'),T=require('../lib/telegramAiBot');
 for(const row of [{betType:'hockey_handicap_home'},{marketDesc:'Set Handicap',sport:'tennis'},{marketDesc:'Puck Line',sport:'hockey'},{sport:'basketball',marketId:'223'},{marketDesc:'1st Half Goal Kicks - Over/Under',outcomeDesc:'Under 8.5'},{betType:'streak_2_no'},{marketDesc:'Any Team To Score 2 or More Goals in a Row',outcomeDesc:'Yes'}]){
  assert.equal(F.removedSelection(row),true);
  assert.equal(S.expandedSelectionAllowed(row,null,true),false);
 }
 assert.equal(F.removedSelection({marketDesc:'Any Team To Score 3 or More Goals in a Row',betType:'streak_3_no'}),false);
 assert.ok(T.ALL_BET_IDS.every(betType=>!F.removedSelection({betType})));
});
