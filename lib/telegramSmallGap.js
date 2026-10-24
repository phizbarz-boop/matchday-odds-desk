'use strict';
const {configuredWinnerOddsGap,key}=require('./winnerOddsGap');
function annotateSmallGap(candidates,winnerRows){
 const matches=configuredWinnerOddsGap(winnerRows.filter(r=>/football|soccer/i.test(r.sport||'')),{winnerGapMaxOne:true});
 // Always overwrite saved flags. Only the currently fetched winner market is proof.
 return candidates.map(c=>({...c,winnerGapMaxOneQualified:matches.has(key(c))}));
}
module.exports={annotateSmallGap};
