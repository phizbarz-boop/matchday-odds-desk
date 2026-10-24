'use strict';
const {configuredWinnerOddsGap,key}=require('./winnerOddsGap');
function annotateSmallGap(candidates,winnerRows){
 const aboveEight=configuredWinnerOddsGap(winnerRows.filter(r=>/football|soccer/i.test(r.sport||'')),{winnerGapAboveEight:true});
 const matches=configuredWinnerOddsGap(winnerRows.filter(r=>/football|soccer/i.test(r.sport||'')),{winnerGapMaxOne:true});
 // Always overwrite saved flags. Only the currently fetched winner market is proof.
 return candidates.map(c=>({...c,winnerGapMaxOneQualified:matches.has(key(c)),winnerGapAboveEightQualified:aboveEight.has(key(c))}));
}
module.exports={annotateSmallGap};
