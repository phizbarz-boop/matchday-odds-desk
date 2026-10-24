'use strict';
const TYPES=[['corners_under115','Corners Under 11.5'],['corners_under125','Corners Under 12.5']];
const IDS=TYPES.map(x=>x[0]);
function betTypeFor(row){
 if(row.live||!/football|soccer/i.test(row.sport||'')||!require('./sportyFootballModel').isFullMatchCorners(row))return null;
 const label=String(row.outcomeDesc||'').trim(),m=label.match(/^under(?:\s+([0-9]+(?:\.[0-9]+)?)(?:\s+corners)?)?$/i);if(!m)return null;
 const spec=String(row.specifier||'').match(/(?:^|[|;&])total=([0-9]+(?:\.[0-9]+)?)(?:$|[|;&])/i);
 const line=spec?Number(spec[1]):m[1]?Number(m[1]):NaN;if(m[1]&&Number(m[1])!==line)return null;
 return line===11.5?IDS[0]:line===12.5?IDS[1]:null;
}
function matches(c,types){return types.includes(c.betType)||types.includes('corners_under')&&IDS.includes(c.betType);}
async function collectCornerMarkets(options={}){return require('./goalKickFeed').collectFootballStatMarkets({...options,marketIds:['166'],source:'SportyBet public corners fixture feed'});}
async function candidatesFromRows(rows,options={}){
 const predictions={matches:await require('./sportyFootballModel').enrichSportyFixtures(rows,{maxFixtures:rows.length||1,marketRows:rows})};
 return require('./autoPicker').buildCandidates({predictions,footballMarkets:{corners:{rows}},sportScope:'football',minProbability:0,minEdge:-25,...options});
}
module.exports={TYPES,IDS,betTypeFor,matches,collectCornerMarkets,candidatesFromRows};
