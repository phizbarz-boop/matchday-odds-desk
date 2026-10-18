'use strict';
const {normalMetrics}=require('./autoPicker');
const key=c=>[c.eventId,c.marketId,c.specifier||'',!!c.live].join('|');
const selectionKey=c=>[c.eventId,c.marketId,c.outcomeId,c.specifier||''].join('|');
function classify(rows){
 const name=String(rows[0]?.marketDesc||'').toLowerCase(),labels=rows.map(c=>String(c.outcomeDesc||'').trim().toLowerCase());
 if(/\b[12]\s*-?\s*up\b|never down|early payout|cash.?out|boost|insurance|double chance|draw no bet|asian|handicap/.test(name))return {reason:'overlap_push_or_special_settlement'};
 if(/half.?time.*full.?time|ht\s*\/\s*ft/.test(name)&&rows.length===9&&['1','x','2'].every(a=>['1','x','2'].every(b=>labels.includes(a+'/'+b))))return {kind:'half_time_full_time'};
 if(/correct score/.test(name)&&labels.some(x=>/^(?:any )?other(?: score)?$/.test(x))&&labels.every(x=>/^\d+\s*[-:]\s*\d+$/.test(x)||/^(?:any )?other(?: score)?$/.test(x)))return {kind:'exhaustive_correct_score'};
 if(/exact|total (?:goals|points|sets|games)|number of/.test(name)){
  const tail=labels.find(x=>/^\d+\+$/.test(x));
  if(tail){const n=Number(tail.slice(0,-1));if(n>0&&rows.length===n+1&&Array.from({length:n},(_,i)=>String(i)).every(x=>labels.includes(x)))return {kind:'exhaustive_count'};}
 }
 if(rows.length===2&&labels.includes('yes')&&labels.includes('no'))return {kind:'yes_no'};
 if(rows.length===2&&labels.includes('odd')&&labels.includes('even'))return {kind:'odd_even'};
 if(rows.length===3&&(['home','draw','away'].every(x=>labels.includes(x))||['1','x','2'].every(x=>labels.includes(x))))return {kind:'three_way_result'};
 if(rows.length===2&&(/winner|moneyline|match result/.test(name))&&labels.some(x=>x==='home'||x===String(rows[0].home).toLowerCase())&&labels.some(x=>x==='away'||x===String(rows[0].away).toLowerCase()))return {kind:'two_way_winner'};
 if(rows.length===2&&labels.some(x=>/^over\b/.test(x))&&labels.some(x=>/^under\b/.test(x))){
  const spec=String(rows[0].specifier||'').match(/(?:^|[|;&])total=([0-9]+(?:\.[0-9]+)?)/i);
  const lines=rows.map(c=>Number(spec?.[1]||String(c.outcomeDesc).match(/(?:over|under)\s+([0-9]+(?:\.[0-9]+)?)/i)?.[1]));
  if(lines.every(Number.isFinite)&&lines[0]===lines[1]&&Math.abs(lines[0]%1-.5)<1e-9)return {kind:'half_line_total'};
  return {reason:'total_push_or_line_unconfirmed'};
 }
 return {reason:'outcome_partition_or_settlement_unconfirmed'};
}
function modelOfferedMarkets(rows,{known=[],predictions={matches:[]},minProbability=0,minEdge=0}={}){
 const extended=[...require('./extendedFootballModel').modelExtendedFootball(rows,{known,predictions,minProbability,minEdge}),...require('./periodGoalModel').modelPeriodGoals(rows,{known,minProbability,minEdge}),...require('./streakGoalModel').modelStreakGoals(rows,{known,predictions,minProbability,minEdge})];known=[...known,...extended];
 const grouped=new Map(),existing=new Set(known.map(selectionKey)),candidates=[...extended],markets=[];
 for(const r of rows){if(!r.eventId||!r.marketId||!r.outcomeId)continue;const k=key(r);if(!grouped.has(k))grouped.set(k,new Map());grouped.get(k).set(String(r.outcomeId),r);}
 for(const [groupKey,map] of grouped){const group=[...map.values()],m=group[0];
  const coverage={outcomes:group.map(c=>({outcomeId:c.outcomeId,outcomeDesc:c.outcomeDesc,odds:c.odds,bookmakerImpliedProbability:Number(c.odds)>1?100/Number(c.odds):null})),knownModeledSelections:group.filter(c=>existing.has(selectionKey(c))).length,eventId:m.eventId,sport:m.sport,marketId:m.marketId,marketDesc:m.marketDesc,specifier:m.specifier||null,offeredOutcomes:group.length};
  if(group.every(c=>existing.has(selectionKey(c)))){markets.push({...coverage,status:'existing_model'});continue;}
  if(group.some(c=>!(Number(c.odds)>1)||c.suspended||c.active===false)||group.some(c=>c.marketOutcomeCount!=null&&c.marketOutcomeCount!==group.length)){markets.push({...coverage,status:'unavailable',reason:'incomplete_or_inactive_outcomes'});continue;}
  const schema=classify(group);if(schema.reason){markets.push({...coverage,status:'unmodeled',reason:schema.reason});continue;}
  const total=group.reduce((n,c)=>n+1/Number(c.odds),0);
  if(total<.9||total>1.5){markets.push({...coverage,status:'unmodeled',reason:'inconsistent_market_price_set'});continue;}
  markets.push({...coverage,status:'market_estimate',schema:schema.kind,independentModel:false});
  for(const c of group){if(existing.has(selectionKey(c)))continue;const metrics=normalMetrics(c.odds,100/Number(c.odds)/total);if(metrics.probability<minProbability||minEdge>0&&metrics.edge<minEdge)continue;
   candidates.push({...c,...metrics,betType:require('./streakGoalModel').betTypeFor(c)||'offered:'+String(c.marketId),marketKind:'offered',probabilitySource:'SportyBet complete-outcome no-vig estimate',edgeType:'market-adjusted',modelBasis:'offered_prices',independentModel:false,marketReliability:null,qualityScore:metrics.probability,qualityScoreBasis:'probability_only_no_empirical_reliability',marketSchema:schema.kind});
  }
 }
 return {candidates,coverage:{discoveredMarketInstances:markets.length,existingModel:markets.filter(m=>m.status==='existing_model').length,marketEstimates:markets.filter(m=>m.status==='market_estimate').length,unmodeled:markets.filter(m=>m.status==='unmodeled'||m.status==='unavailable').length,markets}};
}
module.exports={classify,modelOfferedMarkets,selectionKey};
