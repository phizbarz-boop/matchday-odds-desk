'use strict';
async function collectStreakGoalCandidates(options={}){
 const {minProbability=70,minEdge=-100,...feedOptions}=options;
 // Include ordinary 1X2 and match totals to fit the existing goal-order model.
 const scan=await require('./goalKickFeed').collectFootballStatMarkets({...feedOptions,marketIds:['1','18','60020'],source:'SportyBet public three-goal streak fixture feed'});
 const rows=scan.rows,model=require('./streakGoalModel');
 const predictions={matches:await require('./sportyFootballModel').enrichSportyFixtures(rows,{maxFixtures:rows.length||1,marketRows:rows})};
 const modeled=model.modelStreakGoals(rows,{predictions,minProbability,minEdge});
 // Retain the existing complete-price fallback when calibrated goal rates are
 // unavailable. Never manufacture No from an unmatched Yes outcome.
 const streakRows=rows.filter(r=>model.betTypeFor(r));
 const fallback=require('./offeredMarketModel').modelOfferedMarkets(streakRows,{known:modeled,minProbability,minEdge});
 const candidates=[...modeled,...fallback.candidates].filter(c=>c.betType==='streak_3_no');
 candidates.sourceErrors=scan.errors;candidates.marketCoverage={scan:scan.coverage};
 return candidates;
}
module.exports={collectStreakGoalCandidates};
