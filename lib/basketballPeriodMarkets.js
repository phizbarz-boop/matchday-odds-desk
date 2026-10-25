'use strict';
const TYPES=[['basketball_first_half_over','Basketball 1st Half Total Points Over'],['basketball_first_half_under','Basketball 1st Half Total Points Under'],['basketball_first_quarter_over','Basketball 1st Quarter Total Points Over'],['basketball_first_quarter_under','Basketball 1st Quarter Total Points Under']];
const IDS=TYPES.map(x=>x[0]);
function betTypeFor(c){
 if(!/basket/i.test(c.sport||'')||c.live)return null;
 const name=String(c.marketDesc||'').trim().toLowerCase().replace(/[–—-]/g,' ').replace(/\s+/g,' '),spec=String(c.specifier||'');
 let period;if(/^(?:1st|first) half (?:total points |total |points )?(?:over\s*\/\s*under)$/.test(name)&&!/(?:quarternr|halfnr)=[2-9]/i.test(spec))period='first_half';
 if(/^(?:1st|first) quarter (?:total points |total |points )?(?:over\s*\/\s*under)$/.test(name)&&!/(?:^|[|;&])quarternr=(?!1(?:$|[|;&]))/i.test(spec))period='first_quarter';
 const side=String(c.outcomeDesc||'').trim().match(/^(over|under)(?:\s+(\d+(?:\.\d+)?))?$/i),total=spec.match(/(?:^|[|;&])total=(\d+(?:\.\d+)?)(?:$|[|;&])/i);if(!period||!side||!total||side[2]&&Number(side[2])!==Number(total[1]))return null;
 return 'basketball_'+period+'_'+side[1].toLowerCase();
}
async function collect(options={}){
 const {minProbability=0,minEdge=0,betTypes=IDS,winnerGapOnly=false,winnerGapMaxOne=false,winnerGapAboveEight=false,...feedOptions}=options;
 const scan=await require('./goalKickFeed').collectFootballStatMarkets({...feedOptions,sport:'basketball',marketIds:['68','236','219'],source:'SportyBet public basketball period totals'}),g=require('./winnerOddsGap');
 const qualified=winnerGapOnly||winnerGapMaxOne||winnerGapAboveEight?g.configuredWinnerOddsGap(scan.rows,{winnerGapOnly,winnerGapMaxOne,winnerGapAboveEight}):null;
 const rows=scan.rows.filter(r=>(['68','236'].includes(String(r.marketId)))&&(!qualified||qualified.has(g.key(r))));
 const model=require('./offeredMarketModel').modelOfferedMarkets(rows,{minProbability,minEdge}),candidates=model.candidates.filter(c=>betTypes.includes(c.betType));
 candidates.marketCoverage={...model.coverage,scan:scan.coverage};candidates.sourceErrors=scan.errors;candidates.dataSource=scan.coverage.source;return {candidates,rows,scan};
}
module.exports={TYPES,IDS,betTypeFor,collect};
