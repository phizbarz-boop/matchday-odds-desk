'use strict';
const MINUTE_GOAL_TYPES=[5,10,20].map(n=>['first'+n+'_goals_under05','Total Goals 1–'+n+' Minutes — Under 0.5']);
const SPECIAL_TYPES=[
 ['player_not_to_score','Player Not to Score'],
 ['away_bookings_over05','Away Team Total Bookings Over 0.5'],
 ['sending_off_no','Sending Off — No'],
 ['first_half_substitutions_under05','1st Half Substitutions Under 0.5'],
 ['substitute_goal_no','Goal Scored by a Substitute — No'],
 ['offsides_under45','Total Offsides Under 4.5'],
 ['offsides_under55','Total Offsides Under 5.5'],
 ['away_woodwork_under05','Away Team Post and Crossbar Under 0.5'],
];
const PLAYER_SCORER=/^(?:player (?:not to score|to score(?: anytime)?|(?:anytime )?goalscorer)|(?:anytime )?goalscorer - .+|.+ - (?:player to score|(?:anytime )?goalscorer))$/;
function isPlayerScorerMarket(c){return /^(football|soccer)$/i.test(c.sport||'')&&PLAYER_SCORER.test(String(c.marketDesc||'').toLowerCase().trim());}
function scorerSide(c){
 if(!isPlayerScorerMarket(c))return null;
 const label=String(c.outcomeDesc||'').toLowerCase().trim();
 if(/^player not to score$/i.test(String(c.marketDesc||'').trim())){
  if(label==='yes')return 'no';
  if(label==='no')return 'yes';
 }
 if(/^(?:no|(?:player )?not to score|(?:player )?does not score)$/.test(label))return 'no';
 if(/^(?:yes|(?:player )?to score(?: anytime)?|(?:player )?scores)$/.test(label))return 'yes';
 return null;
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
async function collect({hours=168,leagues=null,minProbability=0,minEdge=0,betTypes=IDS,signal}={}){
 const sporty=require('./sportybet'),base=await sporty.getFootballMarket('1x2',{hours});
 const scan=await require('./expandedMarketScan').scanExpandedMarkets(base.rows||[],{sports:['football'],hours,leagues,signal,budgetMs:20000});
 const model=require('./offeredMarketModel').modelOfferedMarkets(scan.rows,{minProbability,minEdge});
 const candidates=model.candidates.filter(c=>betTypes.includes(c.betType));candidates.marketCoverage={...model.coverage,scan:scan.coverage};candidates.sourceErrors=scan.errors;return candidates;
}
module.exports={TYPES,IDS,MINUTE_GOAL_TYPES,SPECIAL_TYPES,isPlayerScorerMarket,scorerSide,betTypeFor,collect};
