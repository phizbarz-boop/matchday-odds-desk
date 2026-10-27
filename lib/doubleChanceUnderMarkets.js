'use strict';
const TYPES=[['home_away_under45','Home or Away & Under 4.5'],['dc_under45','Double Chance & Under 4.5 (Home/Draw or Draw/Away)']],IDS=TYPES.map(x=>x[0]);
function describe(c){
 if(c.live||!/^(football|soccer)$/i.test(String(c.sport||'')))return null;
 const market=String(c.marketDesc||'').trim().toLowerCase().replace(/\s+/g,' ');
 if(!/^double chance\s*(?:&|and)\s*(?:over\s*\/\s*under|total goals)(?:\s+4\.5)?$/.test(market))return null;
 const raw=String(c.specifier||''),spec=raw.match(/^total=(\d+(?:\.\d+)?)$/);if(raw&&!spec)return null;
 const outcome=String(c.outcomeDesc||'').trim().toLowerCase().replace(/\s+/g,' '),m=outcome.match(/^(home\s*(?:\/|or)\s*draw|draw\s*(?:\/|or)\s*away|home\s*(?:\/|or)\s*away|1x|x2|12)\s*(?:&|and)\s*under(?:\s+(\d+(?:\.\d+)?))?$/);
 if(!m)return null;const lines=[spec?.[1],m[2],market.endsWith('4.5')?'4.5':null].filter(x=>x!=null).map(Number);if(!lines.length||lines.some(x=>x!==4.5))return null;
 const result=/^(?:1x|home.*draw)$/.test(m[1])?'1x':/^(?:x2|draw.*away)$/.test(m[1])?'x2':'12';return {result,line:4.5,betType:result==='12'?IDS[0]:IDS[1]};
}
async function collect(options={}){
 const sporty=require('./sportybet'),base=await sporty.getFootballMarket('1x2',options),scan=await require('./expandedMarketScan').scanExpandedMarkets(base.rows||[],{sports:['football'],hours:options.hours||168,signal:options.signal,budgetMs:20000});
 const modeled=require('./offeredMarketModel').modelOfferedMarkets(scan.rows,{minProbability:options.minProbability||0,minEdge:options.minEdge||0}),candidates=modeled.candidates.filter(c=>IDS.includes(c.betType)&&(!options.betTypes||options.betTypes.includes(c.betType)));
 const gap=require('./winnerOddsGap'),qualified=options.winnerGapOnly||options.winnerGapMaxOne||options.winnerGapAboveEight?gap.configuredWinnerOddsGap(scan.rows,options):null;
 const rows=candidates.filter(c=>!qualified||qualified.has(gap.key(c)));rows.marketCoverage={...modeled.coverage,scan:scan.coverage};rows.dataFetchedAt=new Date().toISOString();rows.sourceErrors=scan.errors;return {sport:'football',market:'dc_under45',rows,probabilityRows:rows,totalReturned:rows.length,fetchedAt:rows.dataFetchedAt,source:'SportyBet public exact double-chance and total markets'};
}
module.exports={TYPES,IDS,describe,collect};
