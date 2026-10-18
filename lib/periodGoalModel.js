'use strict';
const {lineParts,distribution,metrics,masses}=require('./extendedFootballModel');
const key=c=>[c.eventId,c.marketId,c.outcomeId,c.specifier||''].join('|');
const SCOPES={68:{period:'first_half',side:'match'},69:{period:'first_half',side:'home'},70:{period:'first_half',side:'away'},90:{period:'second_half',side:'match'},91:{period:'second_half',side:'home'},92:{period:'second_half',side:'away'}};
function scope(row){const s=SCOPES[String(row.marketId)];if(!s||row.live||!/football|soccer/i.test(row.sport||''))return null;const name=String(row.marketDesc||'');const period=s.period==='first_half'?/^(?:1st|first)\s+half\b/i:/^(?:2nd|second)\s+half\b/i;return period.test(name)&&/over\s*\/\s*under\s*$/i.test(name)&&!/[&]|corner|card|booking|extra|overtime/i.test(name)?s:null;}
function lineOf(row){const m=String(row.specifier||'').match(/^total=([0-9]+(?:\.[0-9]+)?)$/);const n=m?Number(m[1]):null;return n!=null&&n>0&&lineParts(n)?n:null;}
function dist(lam,line,over=true){const parts=lineParts(line);return distribution(masses(lam,0),(goals)=>parts.map(p=>{const x=over?goals-p:p-goals;return x>1e-9?1:x< -1e-9?0:.5;}));}
function priceProbability(lam,line){const d=dist(lam,line),w=d.won+.5*d.half_won,refund=d.push+.5*(d.half_won+d.half_lost);return w/(1-refund);}
function fitPeriodRate(rows){
 const lines=new Map();for(const r of rows){const n=lineOf(r);if(n==null||r.active===false||r.suspended||!(Number(r.odds)>1))continue;if(!lines.has(n))lines.set(n,new Map());lines.get(n).set(String(r.outcomeId),r);}
 const targets=[];for(const [line,map] of lines){if(map.size!==2||!map.has('12')||!map.has('13'))continue;const pair=[map.get('12'),map.get('13')];if(pair.some(r=>r.marketOutcomeCount!=null&&Number(r.marketOutcomeCount)!==2))continue;const total=pair.reduce((s,r)=>s+1/Number(r.odds),0);if(total<.9||total>1.5)continue;targets.push({line,p:(1/Number(pair[0].odds))/total});}
 if(!targets.length)return null;targets.sort((a,b)=>Math.abs(a.p-.5)-Math.abs(b.p-.5));const target=targets[0];let lo=.01,hi=8;
 for(let i=0;i<40;i++){const mid=(lo+hi)/2;if(priceProbability(mid,target.line)<target.p)lo=mid;else hi=mid;}
 const lambda=(lo+hi)/2,error=Math.max(...targets.map(t=>Math.abs(priceProbability(lambda,t.line)-t.p)));return error<=.08?{lambda,maxPriceFitError:error,sourceLines:targets.map(t=>t.line)}:null;
}
function modelPeriodGoals(rows,{known=[],minProbability=0,minEdge=0}={}){
 const existing=new Set(known.map(key)),groups=new Map(),out=[];
 for(const r of rows){if(!scope(r))continue;const k=r.eventId+'|'+r.marketId;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
 for(const group of groups.values()){
  const fit=fitPeriodRate(group);if(!fit)continue;
  for(const c of group){if(existing.has(key(c))||c.active===false||c.suspended||!(Number(c.odds)>1))continue;const s=scope(c),line=lineOf(c),over=String(c.outcomeId)==='12',under=String(c.outcomeId)==='13';if(!s||line==null||(!over&&!under))continue;
   const m=metrics(Number(c.odds),dist(fit.lambda,line,over)),p=m.fullWinProbability;if(p<minProbability||minEdge>0&&m.edge<minEdge)continue;
   out.push({...c,...m,probability:p,fairEquivalentProbability:m.probability,betType:`period_goals_${s.period}_${s.side}_${over?'over':'under'}`,marketKind:'period_goals',modelScope:s.period,teamTotalSide:s.side,modelMetric:'goals',periodGoalLambda:fit.lambda,modelDiagnostics:fit,
    probabilitySource:`SportyBet complete ${s.period==='first_half'?'1st':'2nd'}-half ${s.side==='match'?'match':s.side+' team'} totals fitted Poisson estimate`,modelBasis:'market_calibrated_poisson',independentModel:false,edgeType:'market-adjusted',marketReliability:null,qualityScore:p,qualityScoreBasis:'uncalibrated_model_probability',accuracyStatus:'not_empirically_validated',
    settlementNote:`${s.period==='first_half'?'First':'Second'}-half ${s.side==='match'?'match':s.side+' team'} goals only. Integer equality refunds the stake; quarter lines split the stake. Threshold uses full-win probability.`,modelAssumptions:'Period-specific Poisson distribution fitted to complete prices from this same period and goal scope. Not an independent statistical prediction.'});
  }
 }
 return out;
}
module.exports={SCOPES,scope,lineOf,dist,priceProbability,fitPeriodRate,modelPeriodGoals};
