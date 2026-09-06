const memoryUsers = new Map();

const PLANS = {
  free: { id:'free', name:'Free', priceNgn:0, dailyTickets:2, dailyAnalyzes:0, maxTargetOdds:10, maxSelections:12, sports:['football'], copyHub:false, savedPreferences:false, description:'Try Matchday AI with football-only tickets up to 10x.' },
  pro: { id:'pro', name:'Pro', priceNgn:5000, dailyTickets:5, dailyAnalyzes:2, maxTargetOdds:100, maxSelections:30, sports:['football','basketball','all'], copyHub:false, savedPreferences:true, description:'Full multi-sport AI builder, code analyzer and saved preferences.' },
  elite: { id:'elite', name:'Elite', priceNgn:20000, dailyTickets:10, dailyAnalyzes:5, maxTargetOdds:1000, maxSelections:40, sports:['football','basketball','hockey','all'], copyHub:true, savedPreferences:true, description:'Highest limits, advanced analyzer access and Copy Hub rankings.' }
};

const ALL_BET_TYPES = [
  ['home_win','Home'],['draw','Draw'],['away_win','Away'],['oneup','1UP'],
  ['corners_over','Corners O'],['corners_under','Corners U'],
  ['first_half_home_team_corners','1H Home Corners'],['first_half_away_team_corners','1H Away Corners'],
  ['dc_1x','1X'],['dc_x2','X2'],['dnb','DNB'],['over05','Over 0.5'],['over15','Over 1.5'],['under45','Under 4.5'],
  ['gg_yes','GG'],['ng_no','NG'],['ah_0','AH 0'],['ah_plus025','AH +0.25'],['ah_minus025','AH -0.25'],
  ['basketball_winner','BB Winner'],['basketball_over','BB Over'],['basketball_under','BB Under'],
  ['HK Winner'],['HK Over'],['HK Under']
];
const ALL_BET_IDS = ALL_BET_TYPES.map(x=>x[0]);
const FREE_BET_IDS = ['home_win','draw','away_win'];
const PRO_BET_IDS = [
  'home_win','draw','away_win','oneup','dc_1x','dc_x2','dnb',
  'over05','over15','under45','gg_yes','ng_no',
  'ah_0','ah_plus025','ah_minus025',
  'basketball_winner','basketball_over','basketball_under',
  
];
function allowedBetIdsForPlan(planId){
  if(planId === 'elite') return [...ALL_BET_IDS];
  if(planId === 'pro') return [...PRO_BET_IDS];
  return [...FREE_BET_IDS];
}

function dayKey(now=new Date()){return now.toISOString().slice(0,10)}
function userKey(id){return `telegram:ai:user:${String(id)}`}
function defaultBuilder(){return {sport:'football',targetOdds:10,minProbability:70,minEdge:0,maxMatchOdds:null,maxSelections:12,betTypes:[...FREE_BET_IDS],safe:false}}
function defaultAnalyzer(){return {minProbability:70,horizonDays:14}}
function freshUser(id,from={}){return {telegramId:String(id),username:from.username||'',firstName:from.first_name||'',plan:'free',planExpiresAt:null,usageDay:dayKey(),ticketsUsed:0,analyzesUsed:0,preferences:{sport:'football',maxMatchOdds:null,minProbability:70,builder:defaultBuilder(),analyzer:defaultAnalyzer()},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}
function normalizeUser(u,id,from={}){
  const base=freshUser(id,from); const out={...base,...(u||{}),preferences:{...base.preferences,...(u?.preferences||{})}};
  out.preferences.builder={...defaultBuilder(),...(u?.preferences?.builder||{})};
  out.preferences.analyzer={...defaultAnalyzer(),...(u?.preferences?.analyzer||{})};
  if(!Array.isArray(out.preferences.builder.betTypes)||!out.preferences.builder.betTypes.length) out.preferences.builder.betTypes=[...ALL_BET_IDS];
  if(!PLANS[out.plan]) out.plan='free';
  if(out.plan!=='free'&&out.planExpiresAt&&Date.parse(out.planExpiresAt)<=Date.now()){out.plan='free';out.planExpiresAt=null};
  const allowedBetIds = new Set(allowedBetIdsForPlan(out.plan));
  out.preferences.builder.betTypes = (out.preferences.builder.betTypes||[]).filter(id=>allowedBetIds.has(id));
  if(!out.preferences.builder.betTypes.length) out.preferences.builder.betTypes=[...allowedBetIds];
  if(out.usageDay!==dayKey()){out.usageDay=dayKey();out.ticketsUsed=0;out.analyzesUsed=0}
  if(from.username)out.username=from.username;if(from.first_name)out.firstName=from.first_name;out.updatedAt=new Date().toISOString();return out;
}
async function getUser(redis,id,from={}){let raw=redis?await redis.get(userKey(id)):memoryUsers.get(userKey(id))||null;let parsed=null;try{parsed=raw?(typeof raw==='string'?JSON.parse(raw):raw):null}catch{}const user=normalizeUser(parsed,id,from);await saveUser(redis,user);return user}
async function saveUser(redis,user){const value=JSON.stringify(user);if(redis)await redis.set(userKey(user.telegramId),value);else memoryUsers.set(userKey(user.telegramId),value);return user}
function getPlan(user){return PLANS[user?.plan]||PLANS.free}
async function consume(redis,user,kind){const normalized=normalizeUser(user,user.telegramId);const plan=getPlan(normalized);if(kind==='ticket'){if(normalized.ticketsUsed>=plan.dailyTickets)return{ok:false,user:normalized,plan,reason:'daily_ticket_limit'};normalized.ticketsUsed++}else if(kind==='analyze'){if(normalized.analyzesUsed>=plan.dailyAnalyzes)return{ok:false,user:normalized,plan,reason:'daily_analyzer_limit'};normalized.analyzesUsed++}await saveUser(redis,normalized);return{ok:true,user:normalized,plan}}
async function activatePlan(redis,telegramId,planId,days=30){if(!PLANS[planId]||planId==='free')throw new Error('plan must be pro or elite');const user=await getUser(redis,telegramId);user.plan=planId;user.planExpiresAt=new Date(Date.now()+Math.max(1,Number(days)||30)*86400000).toISOString();await saveUser(redis,user);return user}

function parseNaturalRequest(text){
  const raw=String(text||'').trim(),t=raw.toLowerCase(); if(!raw)return{intent:'menu'};
  if(/^\/start\b|^start$|\bmenu\b|^home$/.test(t))return{intent:'menu'};
  if(/^\/help\b|\bhelp\b|how (do|can) i/.test(t))return{intent:'help'};
  if(/^\/plans\b|\bpricing\b|\bplans?\b|\bupgrade\b|subscription/.test(t))return{intent:'plans'};
  if(/^\/account\b|my plan|my account|usage/.test(t))return{intent:'account'};
  if(/leaderboard|rankings?|top punter|copy hub|copy bet/.test(t))return{intent:'copy'};
  if(/auto builder|build menu|builder/.test(t))return{intent:'builder'};
  const codeMatch=raw.toUpperCase().match(/(?:ANALY[ZS]E|ANALY[ZS]E CODE|CHECK CODE|CODE)\s*[:#-]?\s*([A-Z0-9_-]{4,24})/i);
  if(codeMatch||(/^[A-Z0-9_-]{4,24}$/.test(raw.toUpperCase())&&/[A-Z]/.test(raw)))return{intent:'analyze',bookingCode:(codeMatch?.[1]||raw).toUpperCase()};
  const isTicket=/ticket|slip|odds|acca|accumulator|build|give me|safe|pick/.test(t)||/^\d+(?:\.\d+)?x?$/.test(t);
  if(isTicket){let targetOdds=null;const om=t.match(/(?:target|build|give me|make|at|for)?\s*(\d+(?:\.\d+)?)\s*(?:x|odds?)\b/);if(om)targetOdds=Number(om[1]);if(!targetOdds){const m=t.match(/\b(1\.3(?:0|5)?|5|10|20|50|100|250|500|750|1000)\b/);if(m)targetOdds=Number(m[1])}const safe=/\bsafe\b|safest|low risk/.test(t);if(safe&&!targetOdds)targetOdds=1.325;if(!targetOdds)targetOdds=10;let sport=null;if(/all sports|all sport/.test(t))sport='all';else if(/football|soccer/.test(t))sport='football';else if(/basketball|basket ball/.test(t))sport='basketball';else if(/hockey|ice hockey/.test(t))sport='hockey';const mx=t.match(/(?:max(?:imum)?\s*(?:odd|odds)|nothing above|under)\s*(?:per match\s*)?([1-9]\d*(?:\.\d+)?)/);const mp=t.match(/(?:min(?:imum)?\s*(?:probability|prob)|at least)\s*(\d{2})(?:\s*%)?/);let betTypes=null;if(/over\s*0\.5|o0\.5/.test(t))betTypes=['over05'];else if(/over\s*1\.5|o1\.5/.test(t))betTypes=['over15'];else if(/under\s*4\.5|u4\.5/.test(t))betTypes=['under45'];else if(/double chance/.test(t))betTypes=['dc_1x','dc_x2'];else if(/draw no bet|\bdnb\b/.test(t))betTypes=['dnb'];else if(/\b1up\b|1 up/.test(t))betTypes=['oneup'];return{intent:'ticket',targetOdds,safe,sport,maxMatchOdds:mx?Number(mx[1]):null,minProbability:mp?Number(mp[1]):(safe?80:70),betTypes}}
  return{intent:'chat',text:raw};
}
function planKeyboard(){
  return {inline_keyboard:[
    [{text:'⭐ Choose Pro — ₦5,000',callback_data:'plan:pro'}],
    [{text:'👑 Choose Elite — ₦20,000',callback_data:'plan:elite'}],
    [{text:'🏠 Home',callback_data:'action:home'}]
  ]};
}
function mainKeyboard(){return{inline_keyboard:[[{text:'🎯 Auto Builder',callback_data:'action:builder'},{text:'🔎 Analyze Code',callback_data:'action:analyze'}],[{text:'⭐ Best Picks',callback_data:'ticket:safe'},{text:'📋 My Account',callback_data:'action:account'}],[{text:'👑 Plans',callback_data:'action:plans'},{text:'🏆 Copy Rankings',callback_data:'action:copy'}]]}}
function builderSummary(user){const b=user.preferences.builder, plan=getPlan(user);const sportLabel=b.sport==='hockey'?'Ice Hockey':b.sport==='all'?'All Sports':b.sport[0].toUpperCase()+b.sport.slice(1);return ['⚙️ MATCHDAY AUTO BUILDER','',`Plan: ${plan.name}`,`Sport: ${sportLabel}`,`Target: ${Number(b.targetOdds).toFixed(Number(b.targetOdds)<2?2:0)}x`,`Minimum probability: ${b.minProbability}%`,`Minimum football edge: ${Number(b.minEdge||0).toFixed(1)} pts`,`Maximum odd/match: ${b.maxMatchOdds?Number(b.maxMatchOdds).toFixed(2):'No limit'}`,`Maximum games: ${b.maxSelections}`,`Bet types selected: ${b.betTypes.length}/${ALL_BET_IDS.length}`,'Red-flag protection: ON','','Change any setting below, then tap 🚀 BUILD TICKET.'].join('\n')}
function builderKeyboard(user){const b=user.preferences.builder,plan=getPlan(user);const can=(target)=>target<=plan.maxTargetOdds;return{inline_keyboard:[[{text:'🏟 Sport',callback_data:'builder:sport'},{text:'🎯 Target',callback_data:'builder:target'}],[{text:'📈 Min Probability',callback_data:'builder:prob'},{text:'💰 Max Odd/Match',callback_data:'builder:maxodd'}],[{text:'📊 Min Edge',callback_data:'builder:edge'},{text:'🔢 Max Games',callback_data:'builder:maxgames'}],[{text:`🎲 Bet Types (${b.betTypes.length})`,callback_data:'builder:markets'}],[{text:'🚀 BUILD TICKET',callback_data:'builder:build'}],[{text:'🛡 Safe 1.30–1.35',callback_data:'builder:safe'},{text:can(50)?'🔥 Quick 50x':'🔒 50x Pro',callback_data:can(50)?'set:target:50':'locked:pro'}],[{text:'⬅️ Home',callback_data:'action:home'}]]}}
function sportKeyboard(user){const plan=getPlan(user);const btn=(id,label)=>({text:plan.sports.includes(id)?label:`🔒 ${label}`,callback_data:plan.sports.includes(id)?`set:sport:${id}`:'locked:pro'});return{inline_keyboard:[[btn('football','⚽ Football'),btn('basketball','🏀 Basketball')],[btn('hockey','🏒 Ice Hockey'),btn('all','🌐 All Sports')],[{text:'⬅️ Builder',callback_data:'action:builder'}]]}}
function targetKeyboard(user){const p=getPlan(user),vals=[5,10,20,50,100,250,500,750,1000];const rows=[];for(let i=0;i<vals.length;i+=3)rows.push(vals.slice(i,i+3).map(v=>({text:v<=p.maxTargetOdds?`${v}x`:`🔒 ${v}x`,callback_data:v<=p.maxTargetOdds?`set:target:${v}`:'locked:upgrade'})));rows.push([{text:'⬅️ Builder',callback_data:'action:builder'}]);return{inline_keyboard:rows}}
function probabilityKeyboard(){return{inline_keyboard:[
  [{text:'0%',callback_data:'set:prob:0'},{text:'10%',callback_data:'set:prob:10'},{text:'20%',callback_data:'set:prob:20'}],
  [{text:'30%',callback_data:'set:prob:30'},{text:'40%',callback_data:'set:prob:40'},{text:'50%',callback_data:'set:prob:50'}],
  [{text:'60%',callback_data:'set:prob:60'},{text:'70%',callback_data:'set:prob:70'},{text:'75%',callback_data:'set:prob:75'}],
  [{text:'80%',callback_data:'set:prob:80'},{text:'85%',callback_data:'set:prob:85'},{text:'90%',callback_data:'set:prob:90'}],
  [{text:'95%',callback_data:'set:prob:95'},{text:'⬅️ Builder',callback_data:'action:builder'}]
]}}
function maxOddKeyboard(){return{inline_keyboard:[[{text:'1.10',callback_data:'set:maxodd:1.10'},{text:'1.20',callback_data:'set:maxodd:1.20'},{text:'1.25',callback_data:'set:maxodd:1.25'}],[{text:'1.30',callback_data:'set:maxodd:1.30'},{text:'1.40',callback_data:'set:maxodd:1.40'},{text:'No Limit',callback_data:'set:maxodd:none'}],[{text:'⬅️ Builder',callback_data:'action:builder'}]]}}
function edgeKeyboard(){return{inline_keyboard:[[{text:'-5 pts',callback_data:'set:edge:-5'},{text:'0 pts',callback_data:'set:edge:0'},{text:'+2 pts',callback_data:'set:edge:2'}],[{text:'+3 pts',callback_data:'set:edge:3'},{text:'+5 pts',callback_data:'set:edge:5'},{text:'+10 pts',callback_data:'set:edge:10'}],[{text:'⬅️ Builder',callback_data:'action:builder'}]]}}
function maxGamesKeyboard(user){const p=getPlan(user),vals=[4,6,8,10,12,15,20,25,30,35,40];const rows=[];for(let i=0;i<vals.length;i+=4)rows.push(vals.slice(i,i+4).map(v=>({text:v<=p.maxSelections?String(v):`🔒${v}`,callback_data:v<=p.maxSelections?`set:maxgames:${v}`:'locked:upgrade'})));rows.push([{text:'⬅️ Builder',callback_data:'action:builder'}]);return{inline_keyboard:rows}}
function marketsKeyboard(user){
  const selected=new Set(user.preferences.builder.betTypes||[]), plan=getPlan(user);
  const allowed=new Set(allowedBetIdsForPlan(plan.id)), rows=[];
  for(let i=0;i<ALL_BET_TYPES.length;i+=2){
    rows.push(ALL_BET_TYPES.slice(i,i+2).map(([id,label])=>{
      const unlocked=allowed.has(id);
      return {text:unlocked?`${selected.has(id)?'✅':'⬜'} ${label}`:`🔒 ${label}`,callback_data:unlocked?`market:${id}`:'locked:market'};
    }));
  }
  rows.push([{text:'✅ Select My Plan Markets',callback_data:'markets:all'},{text:'🧹 Clear',callback_data:'markets:clear'}]);
  rows.push([{text:'⬅️ Builder',callback_data:'action:builder'}]);
  return {inline_keyboard:rows};
}
function analyzerSummary(user){const a=user.preferences.analyzer;return ['🔎 SPORTYBET CODE ANALYZER','',`Minimum probability to KEEP: ${a.minProbability}%`,`Search future matches: ${a.horizonDays} days`,'','Set the analysis options below, then tap “Enter Code” and send the SportyBet booking code.'].join('\n')}
function analyzerKeyboard(){return{inline_keyboard:[[{text:'📈 Min Probability',callback_data:'analyzer:prob'},{text:'📅 Horizon',callback_data:'analyzer:horizon'}],[{text:'⌨️ Enter Code',callback_data:'analyzer:enter'}],[{text:'⬅️ Home',callback_data:'action:home'}]]}}
function analyzerProbKeyboard(){return{inline_keyboard:[[{text:'60%',callback_data:'set:anprob:60'},{text:'70%',callback_data:'set:anprob:70'},{text:'75%',callback_data:'set:anprob:75'}],[{text:'80%',callback_data:'set:anprob:80'},{text:'85%',callback_data:'set:anprob:85'},{text:'90%',callback_data:'set:anprob:90'}],[{text:'⬅️ Analyzer',callback_data:'action:analyze'}]]}}
function analyzerHorizonKeyboard(){return{inline_keyboard:[[{text:'7 days',callback_data:'set:horizon:7'},{text:'14 days',callback_data:'set:horizon:14'},{text:'21 days',callback_data:'set:horizon:21'}],[{text:'⬅️ Analyzer',callback_data:'action:analyze'}]]}}
function resultKeyboard(){return{inline_keyboard:[[{text:'🔄 Rebuild',callback_data:'result:rebuild'},{text:'🛡 Make Safer',callback_data:'result:safer'}],[{text:'⚙️ Builder Settings',callback_data:'action:builder'},{text:'🔎 Analyze Code',callback_data:'action:analyze'}],[{text:'🏠 Home',callback_data:'action:home'}]]}}
function plansText(){return ['💎 MATCHDAY AI PLANS','','🆓 FREE — ₦0','• 2 AI tickets/day','• Football only','• Up to 10x target','• Max 12 selections','• Bet types: Home / Draw / Away only','• No code analyzer / Copy Hub','','⭐ PRO — ₦5,000/month','• 5 AI tickets/day','• Football + Basketball only','• Up to 100x target','• Max 30 selections','• Expanded bet types: 1UP, Double Chance, DNB, goals, GG/NG, Asian Handicap, Basketball','• 2 SportyBet code analyses/day','• Saved preferences','','👑 ELITE — ₦20,000/month','• 10 AI tickets/day','• All supported sports','• Up to 1000x target','• Max 40 selections','• ALL bet types including Corners & 1H Team Corners','• 5 code analyses/day','• Copy Hub / punter rankings','• Highest access limits','','All model probabilities are estimates, not guarantees.'].join('\n')}
module.exports={PLANS,ALL_BET_TYPES,ALL_BET_IDS,FREE_BET_IDS,PRO_BET_IDS,allowedBetIdsForPlan,getUser,saveUser,getPlan,consume,activatePlan,parseNaturalRequest,planKeyboard,mainKeyboard,builderSummary,builderKeyboard,sportKeyboard,targetKeyboard,probabilityKeyboard,maxOddKeyboard,edgeKeyboard,maxGamesKeyboard,marketsKeyboard,analyzerSummary,analyzerKeyboard,analyzerProbKeyboard,analyzerHorizonKeyboard,resultKeyboard,plansText};
