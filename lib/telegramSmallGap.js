'use strict';
const {configuredWinnerOddsGap,key}=require('./winnerOddsGap');
function annotateSmallGap(candidates,winnerRows){
 const aboveEight=configuredWinnerOddsGap(winnerRows.filter(r=>/football|soccer/i.test(r.sport||'')),{winnerGapAboveEight:true});
 const belowOne=require('./winnerOddsGap').winnerOddsGap(winnerRows.filter(r=>/football|soccer/i.test(r.sport||'')),1-1e-8,{atMost:true});
 const matches=configuredWinnerOddsGap(winnerRows.filter(r=>/football|soccer/i.test(r.sport||'')),{winnerGapMaxOne:true});
 // Always overwrite saved flags. Only the currently fetched winner market is proof.
 return candidates.map(c=>({...c,winnerGapBelowOneQualified:belowOne.has(key(c)),winnerGapMaxOneQualified:matches.has(key(c)),winnerGapAboveEightQualified:aboveEight.has(key(c))}));
}
module.exports={annotateSmallGap};
