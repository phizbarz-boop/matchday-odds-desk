'use strict';
const TYPES=[['shots_target_under135','Shots on Target Under 13.5'],['shots_target_under125','Shots on Target Under 12.5'],['shots_target_over45','Shots on Target Over 4.5']];
const IDS=TYPES.map(x=>x[0]);
const MARKET_ID='900393'; // Verified full-match SportyBet Shots on Target Over/Under.
function betTypeFor(c){
 if(c.live||!/football|soccer/i.test(c.sport||''))return null;
 const name=String(c.marketDesc||'').trim().toLowerCase().replace(/[–—-]/g,' ').replace(/\s+/g,' ');
 if(!/^(?:total )?shots on target over\s*\/\s*under$/.test(name))return null;
 const side=String(c.outcomeDesc||'').trim().match(/^(under|over)(?:\s+(\d+(?:\.\d+)?))?$/i);if(!side)return null;
 const spec=String(c.specifier||'').match(/(?:^|[|;&])total=(\d+(?:\.\d+)?)(?:$|[|;&])/i);
 const line=spec?Number(spec[1]):side[2]?Number(side[2]):NaN;if(!Number.isFinite(line)||side[2]&&Number(side[2])!==line)return null;
 return side[1].toLowerCase()==='under'?(line===13.5?IDS[0]:line===12.5?IDS[1]:null):line===4.5?IDS[2]:null;
}
async function collectShotsOnTargetMarkets(options={}){
 return require('./goalKickFeed').collectFootballStatMarkets({...options,marketIds:['1',MARKET_ID],source:'SportyBet public full-match shots-on-target feed'});
}
async function collectShotsOnTargetCandidates({minProbability=0,minEdge=0,betTypes=IDS,winnerGapOnly=false,winnerGapMaxOne=false,winnerGapAboveEight=false,...options}={}){
 const scan=await collectShotsOnTargetMarkets(options),gap=require('./winnerOddsGap');
 const on=winnerGapOnly||winnerGapMaxOne||winnerGapAboveEight;
 const qualified=on?gap.configuredWinnerOddsGap(scan.rows,{winnerGapOnly,winnerGapMaxOne,winnerGapAboveEight}):null;
 const rows=scan.rows.filter(r=>String(r.marketId)===MARKET_ID&&(!qualified||qualified.has(gap.key(r))));
 const modeled=require('./offeredMarketModel').modelOfferedMarkets(rows,{minProbability,minEdge});
 const candidates=modeled.candidates.filter(c=>betTypes.includes(c.betType));
 candidates.marketCoverage={...modeled.coverage,scan:scan.coverage};candidates.sourceErrors=scan.errors;candidates.dataSource=scan.coverage.source;candidates.dataFetchedAt=scan.generatedAt;return candidates;
}
module.exports={TYPES,IDS,MARKET_ID,betTypeFor,collectShotsOnTargetMarkets,collectShotsOnTargetCandidates};
