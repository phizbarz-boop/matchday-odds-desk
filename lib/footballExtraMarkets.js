'use strict';
const MINUTE_GOAL_TYPES=[];
const SPECIAL_TYPES=[
 ['first_half_bookings_under25','1st Half Bookings Under 2.5'],
 ['first_half_bookings_under35','1st Half Bookings Under 3.5'],
 ['player_not_to_score','Player Not to Score'],
 ['away_bookings_over05','Away Team Total Bookings Over 0.5'],
 ['sending_off_no','Sending Off — No'],
 ['first_half_substitutions_under05','1st Half Substitutions Under 0.5'],
 ['substitute_goal_no','Goal Scored by a Substitute — No'],
 ['away_woodwork_under05','Away Team Post and Crossbar Under 0.5'],
];
const cleanScorerText=x=>String(x||'').toLowerCase().replace(/[–—]/g,'-').replace(/\s+/g,' ').trim();
function scorerMarket(c){
 if(!/^(football|soccer)$/i.test(c.sport||''))return null;
 const name=cleanScorerText(c.marketDesc);
 // First/last scorers, halves, and multi-goal markets have different settlement.
 if(/\b(?:first|last|half|hat.?trick)\b|\b[2-9]\+/.test(name))return null;
 const generic=/^(?:player (?:not to score|to score(?: anytime)?|(?:anytime )?goalscorer|(?:total )?goals(?: over\s*\/\s*under)?)|(?:anytime )?goalscorer)$/;
 const named=name.match(/^(.+?)\s+-\s+(player (?:not to score|to score)|(?:anytime )?goalscorer|(?:total )?goals(?: over\s*\/\s*under)?)$/)||
  name.match(/^(player (?:not to score|to score)|(?:anytime )?goalscorer)\s+-\s+(.+)$/);
 const explicit=generic.test(name)||Boolean(named);
 if(!explicit)return null;
 if(named&&/\bgoals\b/.test(name)){
  const participant=cleanScorerText(named[1]);
  if(['home','away','home team','away team',cleanScorerText(c.home),cleanScorerText(c.away)].includes(participant)||!c.playerId&&!c.playerName)return null;
 }
 return {negative:/\bnot to score\b/.test(name),total:/\bgoals\b/.test(name)&&!/goalscorer/.test(name)};
}
function isPlayerScorerMarket(c){return !!scorerMarket(c);}
function scorerSide(c){
 const info=scorerMarket(c);if(!info)return null;
 const label=cleanScorerText(c.outcomeDesc);
 if(info.negative&&require('./playerNotScore').playerName(c)&&! /^(?:yes|no)$/.test(label))return 'no';
 if(label==='yes')return info.negative?'no':'yes';
 if(label==='no')return info.negative?'yes':'no';
 if(/^(?:player )?(?:not to score|does not score)$/.test(label))return 'no';
 if(/^(?:player )?(?:to score(?: anytime)?|scores)$/.test(label))return 'yes';
 if(info.total){
  const side=label.match(/^(under|over)(?:\s+(\d+(?:\.\d+)?))?$/);
  const line=String(c.specifier||'').match(/(?:^|[|;&])total=(\d+(?:\.\d+)?)(?:$|[|;&])/);
  if(side&&Number(line?.[1]||side[2])===.5&&(!side[2]||Number(side[2])===.5))return side[1]==='under'?'no':'yes';
 }
 return null;
}
function playerDiagnostics(rows,candidates=[]){
 const groups=new Map();
 for(const c of rows){
  if(!/scor|player.*goals|goals.*player/i.test(c.marketDesc||''))continue;
  const key=JSON.stringify([c.eventId,c.marketId,c.specifier||'',c.marketDesc]);
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(c);
 }
 let recognized=0,binary=0,negative=0;const samples=[];
 for(const group of groups.values()){
  const sides=group.map(scorerSide);
  if(group.some(isPlayerScorerMarket))recognized++;
  if(group.length===2&&sides.includes('yes')&&sides.includes('no'))binary++;
  negative+=sides.filter(x=>x==='no').length;
  if(samples.length<3)samples.push({marketId:group[0].marketId,marketDesc:String(group[0].marketDesc).slice(0,120),outcomes:group.slice(0,3).map(c=>String(c.outcomeDesc).slice(0,100))});
 }
 return {marketInstances:groups.size,recognized,binary,negative,modeled:candidates.filter(c=>c.betType==='player_not_to_score').length,samples};
}
function playerDiagnosticText(d){
 if(!d)return '';
 const l=d.lineups;if(l)return ` Player check: ${l.offered||0} priced selections, ${l.matchedPlayers??l.confirmedStarters??0} players matched to lineup evidence, ${l.unmatchedPlayers||0} names unmatched, ${l.lineupUnavailable||0} selections awaiting lineup data.${l.blockedReason==='API_DAILY_BUDGET'?' The app football API daily allowance is exhausted; check APISPORTS_H2H_DAILY_LIMIT_FOOTBALL (this is separate from the provider plan).':''}${l.fixturesUnavailable?' '+l.fixturesUnavailable+' fixture(s) lacked usable lineup evidence.':''}${l.scanLimited?' '+l.scanLimited+' selections not checked because of scan/time/API limits.':''}${Object.values(l.failures||{}).length?' Lineup source: '+[...new Set(Object.values(l.failures))].slice(0,2).join(', ')+'.':''}`;
 return ` Player-market check: ${d.marketInstances} scorer market(s), ${d.recognized} recognized, ${d.binary} binary pairs, ${d.modeled} modeled Not to Score selections.`+
 (d.samples.length?' Observed: '+d.samples.map(s=>s.marketDesc+' ['+s.outcomes.join(' / ')+']').join('; ')+'.':'');
}
const TYPES=[['away_offsides_over05','Away Team Offsides Over 0.5'],['home_offsides_over05','Home Team Offsides Over 0.5'],...MINUTE_GOAL_TYPES,...SPECIAL_TYPES],IDS=TYPES.map(x=>x[0]);
function betTypeFor(c){
 if(c.live||!/^(football|soccer)$/i.test(c.sport||''))return null;
 const name=String(c.marketDesc||'').toLowerCase().replace(/[–—]/g,'-').replace(/\s+/g,' ').trim(),desc=String(c.outcomeDesc||'').trim(),side=desc.match(/^(over|under)(?:\s+(\d+(?:\.\d+)?))?$/i);
 if(scorerSide(c)==='no')return 'player_not_to_score';
 if(/^no$/i.test(desc)){
  if(/^(?:(?:any|a) )?(?:sending[ -]off|red card)(?: in (?:the )?match)?$/.test(name))return 'sending_off_no';
  if(/^(?:a )?goal(?: to be)? scored by (?:a |any )?substitut(?:e|ion)$|^(?:any )?substitute to score$/.test(name))return 'substitute_goal_no';
 }
 if(!side)return null;
 const spec=String(c.specifier||''),m=spec.match(/(?:^|[|;&])total=(\d+(?:\.\d+)?)(?:$|[|;&])/);
 const line=Number(m?.[1]||side[2]),direction=side[1].toLowerCase();
 if(side[2]&&Number(side[2])!==line)return null;
 const market=name.replace(/\s*(?:[-:]\s*)?(?:over\s*\/\s*under|total)$/,'').trim();
 if(direction==='over'&&line===.5&&/^away(?: team)?\s*[-:]?\s*(?:total )?bookings$/.test(market))return 'away_bookings_over05';
 if(direction==='under'){
  if((line===2.5||line===3.5)&&/^(?:1st|first) half\s*[-:]?\s*(?:total )?bookings$/.test(market))return line===2.5?'first_half_bookings_under25':'first_half_bookings_under35';
  if(line===.5&&/^(?:1st|first) half\s*[-:]?\s*(?:total )?substitutions?$/.test(market))return 'first_half_substitutions_under05';
  if((line===4.5||line===5.5)&&/^(?:total )?offsides?$/.test(market))return line===4.5?'offsides_under45':'offsides_under55';
  if(line===.5&&/^away(?: team)?\s*[-:]?\s*(?:total )?(?:post(?:s)? (?:and|&) crossbar(?:s)?|woodwork)(?: hits)?$/.test(market))return 'away_woodwork_under05';
 }
 if(line!==.5)return null;
 if(side[1].toLowerCase()==='over'){
  if(/\bhalf\b|\bperiod\b|\d\s*-\s*\d/.test(name))return null;
  if(/^(?:away(?: team)?(?: -)? (?:total )?offside[s]?|offside[s]? - away(?: team)?)(?:\s*-?\s*over\s*\/\s*under)?$/.test(name))return IDS[0];
  if(/^(?:home(?: team)?(?: -)? (?:total )?offside[s]?|offside[s]? - home(?: team)?)(?:\s*-?\s*over\s*\/\s*under)?$/.test(name))return IDS[1];
 }
 if(side[1].toLowerCase()==='under'){
  const period=name.match(/^(?:total goals?\s*(?:over\s*\/\s*under)?\s*[-:,]?\s*(?:from\s*)?(?:minutes?\s+)?\(?1\s*(?:-|to)\s*(5|10|20)\s*(?:minutes?|mins?\.?)?\)?|1\s*(?:-|to)\s*(5|10|20)\s*(?:minutes?|mins?\.?)?\s*[-:]?\s*(?:total goals?(?: over\s*\/\s*under)?|over\s*\/\s*under))$/);
  if(period)return 'first'+(period[1]||period[2])+'_goals_under05';
 }
 return null;
}
async function collect({hours=168,leagues=null,minProbability=0,minEdge=0,betTypes=IDS,signal,halfScan=false,todayOnly=false,redis=null}={}){
 const sporty=require('./sportybet'),base=await sporty.getFootballMarket('1x2',{hours,...(halfScan?{maxPages:20}:{})});
 const playerOnly=betTypes.length===1&&betTypes[0]==='player_not_to_score',playerRows=[];
 // Stream fixture details and retain only scorer markets for a larger player scan.
 const scan=await require('./expandedMarketScan').scanExpandedMarkets(base.rows||[],{sports:['football'],hours,leagues,signal,budgetMs:20000,halfScan,todayOnly,...(playerOnly?{maxEventsOverride:160,onFixtureRows:rows=>playerRows.push(...rows.filter(isPlayerScorerMarket))}:{})});
 // Listing rows are already current public outcomes; keep them when a detail route fails.
 const unique=new Map([...base.rows||[],...scan.rows,...playerRows].map(c=>[JSON.stringify([c.eventId,c.marketId,c.outcomeId,c.specifier||'']),c]));
 const marketRows=[...unique.values()].filter(c=>!c.live&&Date.parse(c.kickoffUtc)>Date.now()&&Date.parse(c.kickoffUtc)<=Date.now()+hours*3600000&&(!leagues?.length||leagues.includes(c.tournament))); 
 const model=require('./offeredMarketModel').modelOfferedMarkets(marketRows,{minProbability,minEdge});
 let candidates=model.candidates.filter(c=>betTypes.includes(c.betType));
 const lineupDiagnostics={};
 if(betTypes.includes('player_not_to_score')){const players=require('./playerNotScore'),offered=[...candidates.filter(c=>c.betType==='player_not_to_score'),...players.singlePriceCandidates(marketRows,candidates)];const verified=await players.enrich(offered,{loadLineup:await players.lineupLoader({redis,signal}),minProbability,minEdge,diagnostics:lineupDiagnostics});candidates=[...candidates.filter(c=>c.betType!=='player_not_to_score'),...verified];}
candidates.marketCoverage={...model.coverage,scan:scan.coverage,playerScorer:{...playerDiagnostics(marketRows,model.candidates),lineups:lineupDiagnostics}};candidates.sourceErrors=scan.errors;return candidates;
}
module.exports={TYPES,IDS,MINUTE_GOAL_TYPES,SPECIAL_TYPES,playerDiagnostics,playerDiagnosticText,isPlayerScorerMarket,scorerSide,betTypeFor,collect};

const REMOVED_IDS=['first5_goals_under05', 'first10_goals_under05', 'first20_goals_under05', 'offsides_under45', 'offsides_under55', 'correct_score'];
function removedSelection(c){const n=String(c.marketDesc||'').toLowerCase().replace(/[–—]/g,'-');return REMOVED_IDS.includes(c.betType)||/correct score/.test(n)||(/^total (?:goals?|over\s*\/\s*under)/.test(n)&&/1\s*(?:-|to)\s*(?:5|10|20)\b/.test(n)&&/^under\b/i.test(c.outcomeDesc||''))||(/^(?:total )?offsides?(?:\s*(?:over\s*\/\s*under|total))?$/.test(n)&&/^under\b/i.test(c.outcomeDesc||'')&&/(?:total=|under\s+)(?:4\.5|5\.5)(?:$|[|;&\s])/i.test(String(c.specifier||'')+' '+String(c.outcomeDesc||'')));}
module.exports.REMOVED_IDS=REMOVED_IDS;module.exports.removedSelection=removedSelection;
