'use strict';
const {IDS}=require('./goalKickMarkets');
function expandedScanPolicy(betTypes,marketHours,env=process.env){
 const goalKickOnly=Array.isArray(betTypes)&&betTypes.length>0&&betTypes.every(id=>IDS.includes(id));
 const defaultHours=Math.max(1,Math.min(504,parseInt(env.SPORTYBET_HOURS||String((parseInt(env.DAYS_AHEAD||'4',10)+1)*24),10)||120));
 const hours=Math.max(1,Math.min(504,Number(marketHours)||(goalKickOnly?168:defaultHours)));
 return {goalKickOnly,hours,...(goalKickOnly?{budgetMs:90000,detailTimeoutMs:6000,maxEventsOverride:400}:{})};
}
module.exports={expandedScanPolicy};
