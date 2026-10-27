'use strict';
const {scoreMatrix}=require('./model');
const {normalMetrics}=require('./autoPicker');
const key=c=>[c.eventId,c.marketId,c.outcomeId,c.specifier||''].join('|');
const spec=(s,k)=>{const m=String(s||'').match(new RegExp('(?:^|[|;])'+k+'=([+-]?\\d+(?:\\.\\d+)?)'));return m?Number(m[1]):null;};
function masses(lh,la){const m=scoreMatrix(lh,la,30),mass=m.flat().reduce((a,b)=>a+b,0);return m.map(row=>row.map(p=>p/mass));}
function result(m){let h=0,d=0,a=0;for(let i=0;i<m.length;i++)for(let j=0;j<m[i].length;j++){if(i>j)h+=m[i][j];else if(i===j)d+=m[i][j];else a+=m[i][j];}return [h,d,a];}
function above(lam,n){let p=Math.exp(-lam),sum=p;for(let k=1;k<=n;k++){p*=lam/k;sum+=p;}return 1-sum;}
function noVig(rows){if(rows.some(r=>!(Number(r.odds)>1)||r.active===false||r.suspended||r.marketOutcomeCount!=null&&Number(r.marketOutcomeCount)!==rows.length))return null;const sum=rows.reduce((n,r)=>n+1/Number(r.odds),0);return sum>=.9&&sum<=1.5?rows.map(r=>1/Number(r.odds)/sum):null;}
function fitRates(rows){
 const group=new Map();for(const r of rows){const k=r.marketId+'|'+(r.specifier||'');if(!group.has(k))group.set(k,new Map());group.get(k).set(String(r.outcomeId),r);}
 let resultTarget,totalTargets=[];
 for(const map of group.values()){const rs=[...map.values()];if(String(rs[0].marketId)==='1'&&rs.length===3&&['1','2','3'].every(id=>map.has(id))){const ordered=['1','2','3'].map(id=>map.get(id));resultTarget=noVig(ordered);}
 if(String(rs[0].marketId)==='18'&&rs.length===2&&map.has('12')&&map.has('13')){const line=spec(rs[0].specifier,'total');if(line!=null&&Math.abs(line%1-.5)<1e-8){const p=noVig([map.get('12'),map.get('13')]);if(p)totalTargets.push({line,p:p[0]});}}}
 if(!resultTarget||!totalTargets.length)return null;
 // Prefer the middle of the distribution to avoid extreme-price sensitivity.
 totalTargets.sort((a,b)=>Math.abs(a.p-.5)-Math.abs(b.p-.5));const t=totalTargets[0];let lo=.05,hi=12;
 for(let i=0;i<45;i++){const mid=(lo+hi)/2;if(above(mid,Math.floor(t.line))<t.p)lo=mid;else hi=mid;}const total=(lo+hi)/2;
 if(totalTargets.some(x=>Math.abs(above(total,Math.floor(x.line))-x.p)>.08))return null;
 let best;for(let n=1;n<100;n++){const lh=total*n/100,la=total-lh,probs=result(masses(lh,la));const error=probs.reduce((s,p,i)=>s+(p-resultTarget[i])**2,0);if(!best||error<best.error)best={lh,la,error,probs};}
 if(!best||best.probs.some((p,i)=>Math.abs(p-resultTarget[i])>.08))return null;
 return {...best,basis:'market_calibrated_poisson',independent:false};
}
function lineParts(line){const q=Math.round(line*4);if(Math.abs(line*4-q)>1e-8)return null;return Math.abs(q)%2===1?[(q-1)/4,(q+1)/4]:[line];}
function payoff(value,line){return value+line>1e-9?1:value+line< -1e-9?0:.5;}
function distribution(m,fn){const out={won:0,push:0,lost:0,half_won:0,half_lost:0};for(let h=0;h<m.length;h++)for(let a=0;a<m[h].length;a++){const values=fn(h,a),win=values.filter(v=>v===1).length/values.length,push=values.filter(v=>v===.5).length/values.length;const label=win===1?'won':push===1?'push':win===.5&&push===.5?'half_won':win===0&&push===.5?'half_lost':'lost';out[label]+=m[h][a];}return out;}
function metrics(odds,d){const winStake=d.won+.5*d.half_won,refund=d.push+.5*(d.half_won+d.half_lost),fair=winStake>0?(1-refund)/winStake:Infinity;return {probability:winStake/(1-refund)*100,fullWinProbability:d.won*100,nonLossProbability:(d.won+d.push+d.half_won)*100,pushProbability:d.push*100,halfWinProbability:d.half_won*100,halfLossProbability:d.half_lost*100,lossProbability:d.lost*100,fairOdds:Number.isFinite(fair)?fair:null,impliedProbability:100/odds,edge:winStake/(1-refund)*100-100/odds,expectedReturnMultiplier:winStake*odds+refund,expectedValuePct:(winStake*odds+refund-1)*100,settlementNote:'Full win, push, half-win, half-loss and loss calculated separately; probability is fair-price equivalent'};}
function binom(n,k){if(k<0||k>n)return 0;let x=1;for(let i=1;i<=k;i++)x=x*(n-i+1)/i;return x;}
function earlyConditional(h,a,lead){if(h>a)return 1;if(h<lead)return 0;return binom(h+a,h-lead)/binom(h+a,h);}
function earlyProbability(m,side,lead){let p=0;for(let h=0;h<m.length;h++)for(let a=0;a<m[h].length;a++)p+=m[h][a]*earlyConditional(side==='home'?h:a,side==='home'?a:h,lead);return p;}
function modelExtendedFootball(rows,{predictions={matches:[]},known=[],minProbability=0,minEdge=0}={}){
 const byEvent=new Map(),knownKeys=new Set(known.map(key)),models=new Map((predictions.matches||[]).map(p=>[String(p.eventId||p.sportyEventId),p])),candidates=[];
 for(const row of rows){if(row.live||!/football|soccer/i.test(row.sport||''))continue;const id=String(row.eventId);if(!byEvent.has(id))byEvent.set(id,[]);byEvent.get(id).push(row);}
 for(const [id,rs] of byEvent){const p=models.get(id);let rates;
 if(p?.goalModelAvailable&&Number(p.goalLambdaHome)>0&&Number(p.goalLambdaAway)>0&&p.goalLambdaHome<=6&&p.goalLambdaAway<=6)rates={lh:Number(p.goalLambdaHome),la:Number(p.goalLambdaAway),basis:'statistics_poisson',independent:true};else rates=fitRates(rs);
 if(!rates)continue;const m=masses(rates.lh,rates.la);
 for(const c of rs){if(knownKeys.has(key(c))||!(Number(c.odds)>1)||c.suspended||c.active===false)continue;
 const name=String(c.marketDesc||''),desc=String(c.outcomeDesc||''),mid=String(c.marketId),oid=String(c.outcomeId);let values,betType,settlement;
 // Exact full-regulation IDs only. Never extend an unrelated period or promo.
 if(/\b(?:half|period|quarter|corner|card|booking|set|overtime|extra)\b/i.test(name))continue;
 if(require('./doubleChanceUnderMarkets').describe(c)){const combo=require('./doubleChanceUnderMarkets').describe(c);values=metrics(Number(c.odds),distribution(m,(h,a)=>[h+a<4.5&&(combo.result==='12'?h!==a:combo.result==='1x'?h>=a:a>=h)?1:0]));betType=combo.betType;settlement='Both conditions must win: selected double-chance result and total match goals under 4.5, in regulation time.';
 }else if(['18','19','20'].includes(mid)){if(!/^total=[+-]?\d+(?:\.\d+)?$/.test(String(c.specifier||'')))continue;const line=spec(c.specifier,'total'),parts=line==null?null:lineParts(line);const over=oid==='12',under=oid==='13';if(!parts||(!over&&!under))continue;const side=mid==='19'?'home':mid==='20'?'away':'match';
 values=metrics(Number(c.odds),distribution(m,(h,a)=>{const v=side==='home'?h:side==='away'?a:h+a;return parts.map(l=>payoff(over?v:-v,over?-l:l));}));betType=side==='match'?`football_total_${over?'over':'under'}`:`${side}_${over?'over':'under'}_extended`;
 }else if(mid==='16'){if(!/^hcp=[+-]?\d+(?:\.\d+)?$/.test(String(c.specifier||'')))continue;const homeLine=spec(c.specifier,'hcp'),parts=homeLine==null?null:lineParts(homeLine);const side=/\bhome\b/i.test(desc)?'home':/\baway\b/i.test(desc)?'away':null;if(!parts||!side)continue;
 values=metrics(Number(c.odds),distribution(m,(h,a)=>parts.map(l=>payoff(side==='home'?h-a:a-h,side==='home'?l:-l))));betType='ah_extended';
 }else if(['60100','60200'].includes(mid)&&/1x2.*[12]\s*-?\s*up/i.test(name)){const side=oid==='1'?'home':oid==='3'?'away':oid==='2'?'draw':null;if(!side)continue;const lead=mid==='60200'?1:2;const prob=side==='draw'?result(m)[1]:earlyProbability(m,side,lead);values=normalMetrics(c.odds,prob*100);betType=lead===1?'oneup_extended':'twoup_extended';settlement=`${lead}UP: selected team reaches a ${lead}-goal lead at any time OR wins at full time; draw is ordinary full-time draw. Constant independent scoring-rate assumption.`;
 }else continue;
 const winProbability=values.fullWinProbability??values.probability;
 if(!Number.isFinite(winProbability)||winProbability<minProbability||minEdge>0&&values.edge<minEdge)continue;
 candidates.push({...c,...values,fairEquivalentProbability:values.probability,probability:winProbability,betType,marketKind:'extended_football',probabilitySource:rates.independent?'SportyBet displayed statistics + Poisson settlement model':'SportyBet complete 1X2 + totals calibrated Poisson estimate',modelBasis:rates.basis,independentModel:rates.independent,edgeType:rates.independent?'model-vs-price':'market-adjusted',goalLambdaHome:rates.lh,goalLambdaAway:rates.la,marketReliability:null,qualityScore:winProbability,qualityScoreBasis:'uncalibrated_model_probability',accuracyStatus:'not_empirically_validated',...(settlement?{settlementNote:settlement}:{}),modelAssumptions:'Independent Poisson regulation-time goals; constant rates for early payout. No guarantee of predictive calibration.'});
 }
 }
 return candidates;
}
module.exports={modelExtendedFootball,fitRates,lineParts,distribution,metrics,earlyConditional,earlyProbability,masses};
