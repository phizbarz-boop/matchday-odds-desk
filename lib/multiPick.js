'use strict';
const TYPES=['away_under45','home_under45','under45','over05','shots_target_under135','away_offsides_over05','shots_target_over45'];
const between=(g,a,b)=>g>=a-1e-9&&g<=b+1e-9;
function matches(c,g){if(!Number.isFinite(g)||g<0||c.live||!/^(football|soccer)$/i.test(c.sport||''))return false;
 switch(c.betType){case 'away_under45':return between(g,5,8)||between(g,1.01,2);case 'home_under45':return between(g,0,.5);case 'under45':return between(g,0,1);case 'over05':return g>8+1e-9;case 'shots_target_under135':return between(g,5.01,8);case 'away_offsides_over05':return between(g,.51,1);case 'shots_target_over45':return between(g,2,5);default:return false;}
}
function annotate(candidates,winners){const gap=require('./winnerOddsGap'),prices=gap.winnerOddsGap(winners,-1);return candidates.map(c=>{const g=prices.get(gap.key(c))?.gap;return {...c,multiWinnerGap:g??null,multiQualified:matches(c,g)};});}
async function collect({loadCandidates,hours=168,leagues=null,signal,halfScan=false,todayOnly=false}={}){
 const rows=await loadCandidates({sportScope:'football',sports:['football'],marketHours:hours,leagues,betTypes:TYPES,minProbability:0,minEdge:-25,ignoreEdge:true,includeAllMarkets:true,liveMode:'prematch',halfScan,todayOnly});
 const feed=await require('./goalKickFeed').collectFootballStatMarkets({marketIds:['1'],hours,signal,source:'SportyBet Multi current 1X2 prices'});
 const out=annotate(rows,feed.rows).filter(c=>c.multiQualified);for(const k of Object.keys(rows))if(!/^\d+$/.test(k))out[k]=rows[k];return out;
}
function ticket(rows,{maxSelections=20,excludedTickets=new Set(),now=new Date()}={}){
 const {winningProbability}=require('./telegramNext12h'),{ticketSignature}=require('./ticketVariation');
 const sorted=rows.filter(c=>c.multiQualified&&matches(c,c.multiWinnerGap)&&(c.fullWinProbability??c.probability)!=null&&c.h2hCheck?.allowed!==false&&Number.isFinite(winningProbability(c))&&winningProbability(c)>=0&&winningProbability(c)<=100&&Number(c.odds)>1&&Date.parse(c.kickoffUtc)>+now+60000).sort((a,b)=>winningProbability(b)-winningProbability(a)||Number(a.odds)-Number(b.odds)||String(a.eventId).localeCompare(String(b.eventId)));
 const distinct=[];for(const c of sorted)if(!distinct.some(x=>String(x.eventId)===String(c.eventId)))distinct.push(c);
 const n=Math.max(1,Math.min(50,Number(maxSelections)||20));let selections=distinct.slice(0,n);
 if(excludedTickets.has(ticketSignature(selections))){let found=null;for(let i=selections.length-1;i>=0&&!found;i--)for(const c of sorted){if(selections.some((x,j)=>j!==i&&String(x.eventId)===String(c.eventId)))continue;const alt=selections.slice();alt[i]=c;if(!excludedTickets.has(ticketSignature(alt))){found=alt;break;}}selections=found||[];}
 const combinedOdds=selections.reduce((n,c)=>n*Number(c.odds),1),estimatedSlipProbability=selections.reduce((n,c)=>n*winningProbability(c)/100,1)*100;
 return {selections,combinedOdds:selections.length?combinedOdds:0,reachedTarget:true,estimatedSlipProbability:selections.length?estimatedSlipProbability:0,averageProbability:selections.length?selections.reduce((n,c)=>n+winningProbability(c),0)/selections.length:0,averageEdge:selections.length?selections.reduce((n,c)=>n+(Number(c.edge)||0),0)/selections.length:0,averageQualityScore:selections.length?selections.reduce((n,c)=>n+(Number(c.qualityScore)||winningProbability(c)),0)/selections.length:0,estimatedSlipEVPct:selections.length?(combinedOdds*estimatedSlipProbability/100-1)*100:0,candidateCount:sorted.length};
}
module.exports={TYPES,matches,annotate,collect,ticket};
