'use strict';
const TYPES=[['away_offsides_over05','Away Team Offsides Over 0.5'],['home_offsides_over05','Home Team Offsides Over 0.5'],['first5_goals_under05','Goals 1–5 Minutes Under 0.5']],IDS=TYPES.map(x=>x[0]);
function betTypeFor(c){
 if(c.live||!/^(football|soccer)$/i.test(c.sport||''))return null;
 const name=String(c.marketDesc||'').toLowerCase().replace(/[–—]/g,'-').replace(/\s+/g,' ').trim(),desc=String(c.outcomeDesc||'').trim(),side=desc.match(/^(over|under)(?:\s+(\d+(?:\.\d+)?))?$/i);
 if(!side)return null;const spec=String(c.specifier||''),m=spec.match(/(?:^|[|;&])total=(\d+(?:\.\d+)?)(?:$|[|;&])/);const line=Number(m?.[1]||side[2]);if(line!==.5||side[2]&&Number(side[2])!==line)return null;
 if(side[1].toLowerCase()==='over'){
  if(/\bhalf\b|\bperiod\b|\d\s*-\s*\d/.test(name))return null;
  if(/^(?:away(?: team)?(?: -)? (?:total )?offside[s]?|offside[s]? - away(?: team)?)(?:\s*-?\s*over\s*\/\s*under)?$/.test(name))return IDS[0];
  if(/^(?:home(?: team)?(?: -)? (?:total )?offside[s]?|offside[s]? - home(?: team)?)(?:\s*-?\s*over\s*\/\s*under)?$/.test(name))return IDS[1];
 }
 if(side[1].toLowerCase()==='under'&&/^(?:total goals? (?:over\s*\/\s*under)?\s*[-:]?\s*\(?1\s*-\s*5\s*(?:minutes?|mins?\.?)?\)?|1\s*-\s*5\s*(?:minutes?|mins?\.?)?\s*[-:]?\s*(?:total goals?|over\s*\/\s*under))$/.test(name))return IDS[2];
 return null;
}
async function collect({hours=168,leagues=null,minProbability=0,minEdge=0,betTypes=IDS,signal}={}){
 const sporty=require('./sportybet'),base=await sporty.getFootballMarket('1x2',{hours});
 const scan=await require('./expandedMarketScan').scanExpandedMarkets(base.rows||[],{sports:['football'],hours,leagues,signal,budgetMs:20000});
 const model=require('./offeredMarketModel').modelOfferedMarkets(scan.rows,{minProbability,minEdge});
 const candidates=model.candidates.filter(c=>betTypes.includes(c.betType));candidates.marketCoverage={...model.coverage,scan:scan.coverage};candidates.sourceErrors=scan.errors;return candidates;
}
module.exports={TYPES,IDS,betTypeFor,collect};
