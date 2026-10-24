const test=require('node:test'),assert=require('node:assert/strict');const S=require('../lib/streakGoalModel');const G=require('../lib/winnerOddsGap');const {modelOfferedMarkets}=require('../lib/offeredMarketModel');const {settleSelection}=require('../lib/liveSettlement');
const row=(id,desc,odds,extra={})=>({eventId:'E',sport:'Football',home:'H',away:'A',marketId:'1',outcomeId:id,outcomeDesc:desc,marketDesc:'1X2',odds,...extra});
test('odds gap is strictly above five, ignores draw odds, and never mixes fixtures or live states',()=>{assert.equal(G.winnerOddsGap([row('1','Home',1.2),row('3','Away',7),row('2','Draw',100)]).size,1);for(const a of [6.2])assert.equal(G.winnerOddsGap([row('1','Home',1.2),row('3','Away',a)]).size,0);assert.equal(G.winnerOddsGap([row('1','Home',4.31),row('3','Away',9.31)]).size,0);assert.equal(G.winnerOddsGap([row('1','Home',1.2),row('3','Away',7,{eventId:'other'})]).size,0);assert.equal(G.winnerOddsGap([row('1','Home',1.2),row('3','Away',7,{live:true})]).size,0);assert.equal(G.winnerOddsGap([row('1','Home',1.2,{marketId:'60200'}),row('3','Away',7,{marketId:'60200'})]).size,0);});
test('non-football opponents can use their team names and unavailable prices never qualify',()=>{assert.equal(G.winnerOddsGap([row('1','H',1.1,{sport:'Tennis',marketDesc:'Winner'}),row('2','A',7,{sport:'Tennis',marketDesc:'Winner'})]).size,1);assert.equal(G.winnerOddsGap([row('1','Home',1.2),row('3','Away',7,{active:false})]).size,0);});
function brute(lh,la,k){const lambda=lh+la,p=lh/lambda;let yes=0,pmf=Math.exp(-lambda);for(let n=0;n<=12;n++){let value=0;function visit(i,last,run,hit,prob){if(i===n){if(hit)value+=prob;return;}for(const [side,q] of [['h',p],['a',1-p]]){const r=side===last?run+1:1;visit(i+1,side,r,hit||r>=k,prob*q);}}visit(0,'',0,false,1);yes+=pmf*value;pmf*=lambda/(n+1);}return yes;}
test('streak state model agrees with exhaustive goal orders and one-sided Poisson tails',()=>{for(const k of [2,3]){assert.ok(Math.abs(S.streakProbability(.8,.7,k)-brute(.8,.7,k))<1e-8);assert.equal(S.streakProbability(0,0,k),0);assert.ok(Math.abs(S.streakProbability(1,2,k)-S.streakProbability(2,1,k))<1e-12);}assert.ok(S.streakProbability(1.5,1,2)>=S.streakProbability(1.5,1,3));assert.ok(Math.abs(S.streakProbability(2,0,2)-(1-Math.exp(-2)*3))<1e-12);});
test('Yes and No keep exact SportyBet IDs and are complements, not home/away total goals',()=>{const rows=[row('74','Yes',2,{marketId:'60010',marketDesc:'Any Team To Score 2 or More Goals in a Row'}),row('76','No',2,{marketId:'60010',marketDesc:'Any Team To Score 2 or More Goals in a Row'})];const predictions={matches:[{eventId:'E',goalModelAvailable:true,goalLambdaHome:1.5,goalLambdaAway:1}]};const cs=modelOfferedMarkets(rows,{predictions}).candidates;assert.deepEqual(cs.map(c=>c.betType),['streak_2_yes','streak_2_no']);assert.equal(cs[0].marketId,'60010');assert.ok(Math.abs(cs[0].probability+cs[1].probability-100)<.11);assert.equal(settleSelection(cs[0],{matchStatus:'Finished',homeScore:2,awayScore:1},null).status,'pending');});
test('website and bot expose new markets and gap option while scans filter before modeling',()=>{const fs=require('fs'),source=fs.readFileSync(require.resolve('../server'),'utf8'),html=fs.readFileSync(require('path').join(__dirname,'../public/index.html'),'utf8'),bot=require('../lib/telegramAiBot');for(const id of S.IDS){assert.ok(bot.ALL_BET_IDS.includes(id));assert.ok(html.includes(id));}assert.ok(html.includes('auto-winner-gap'));assert.ok(source.includes("d==='builder:gap'"));const a=source.indexOf('    applyWinnerGap();'),b=source.indexOf("predictions=await safeMarket('current football modelling'");assert.ok(a>0&&a<b);});

test('choosing only streak Yes with extra markets off cannot return unrelated markets or No',()=>{assert.equal(S.expandedSelectionAllowed({betType:'streak_2_yes'},['streak_2_yes'],false),true);for(const betType of ['streak_2_no','offered:900','football_total_over'])assert.equal(S.expandedSelectionAllowed({betType},['streak_2_yes'],false),false);});

test('gap ≤1 includes equality while gap >8 excludes equality and ignores draw odds',()=>{
 const rows=gap=>[row('1','Home',1.7),row('3','Away',1.7+gap),row('2','Draw',99)];
 for(const n of [0,.3,1])assert.equal(G.configuredWinnerOddsGap(rows(n),{winnerGapMaxOne:true}).size,1);
 assert.equal(G.configuredWinnerOddsGap(rows(1.01),{winnerGapMaxOne:true}).size,0);
 for(const n of [0,1,2,8])assert.equal(G.configuredWinnerOddsGap(rows(n),{winnerGapAboveEight:true}).size,0);
 assert.equal(G.configuredWinnerOddsGap(rows(8.01),{winnerGapAboveEight:true}).size,1);
 assert.equal(G.configuredWinnerOddsGap([row('1','Home',12),row('3','Away',2)],{winnerGapAboveEight:true}).size,1);
 for(const names of [['winnerGapOnly','winnerGapMaxOne'],['winnerGapOnly','winnerGapAboveEight'],['winnerGapMaxOne','winnerGapAboveEight']])assert.throws(()=>G.configuredWinnerOddsGap([],Object.fromEntries(names.map(k=>[k,true]))),/Choose only one/);
});
test('small-gap filters never invent winner prices or mix periods, live states, fixtures or markets',()=>{
 const opts={winnerGapMaxOne:true},h=row('1','H',2,{sport:'Tennis',marketId:'186',marketDesc:'Winner'}),a={...h,outcomeId:'2',outcomeDesc:'A',odds:2.5};
 assert.equal(G.configuredWinnerOddsGap([h,a],opts).size,1);
 for(const change of [{eventId:'other'},{live:true},{marketId:'other'},{active:false},{suspended:true},{odds:0}])assert.equal(G.configuredWinnerOddsGap([h,{...a,...change}],opts).size,0);
 for(const name of ['1st Set Winner','1st Half Winner','Total Games','Handicap','Home Corners Winner','Next Goal'])assert.equal(G.configuredWinnerOddsGap([h,a].map(c=>({...c,marketDesc:name})),opts).size,0);
});
test('website and bot expose both persisted small-gap options and keep them mutually exclusive',async()=>{
 const bot=require('../lib/telegramAiBot'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
 const user=await bot.getUser(null,'gap-buttons',{});user.preferences.builder.winnerGapAboveEight=true;
 const buttons=bot.builderKeyboard(user).inline_keyboard.flat();for(const id of ['builder:gap','builder:gapmaxone','builder:gapaboveeight'])assert.ok(buttons.some(b=>b.callback_data===id));assert.match(bot.builderSummary(user),/> 8.00: ON/);
 const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');for(const id of ['auto-winner-gap-max-one','auto-winner-gap-above-eight'])assert.ok(html.includes(id));
 for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
 const ids=['auto-winner-gap','auto-winner-gap-max-one','auto-winner-gap-above-eight'];
 const nodes=Object.fromEntries([...ids,'min-prob','limit-select','auto-pick','auto-pick-code','auto-target','auto-max-match-odds','auto-min-prob','auto-min-edge','auto-max','auto-live-mode'].map(id=>[id,{checked:false}]));
 let saved=0;vm.runInNewContext(html.split('\n').find(l=>l.startsWith("document.getElementById('min-prob').oninput=")),{document:{getElementById:id=>nodes[id]},readAutoInputs:()=>saved++,autoPick:()=>{}});
 for(const id of ids){nodes[id].checked=true;nodes[id].onchange();assert.equal(ids.filter(k=>nodes[k].checked).length,1);assert.equal(nodes[id].checked,true);}assert.equal(saved,3);
});
