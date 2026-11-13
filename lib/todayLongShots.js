'use strict';
const {winningProbability,ticketSignature}=require('./telegramNext12h');
const COUNT=50,TARGET=100000,MIN_ODDS=1000,MAX_LEG_ODDS=2;
// Retain the existing first slot ID so a resumed job cannot repost it.
const PLANS=[{id:'today10k1',label:'TODAY 100,000x+',floor:70,minGames:1,maxGames:COUNT,targetOdds:TARGET,minimumOdds:MIN_ODDS,todayLongShot:true}];
// Use market labels as well as the model key: offered markets can have generic IDs.
function balancedLeg(c,maxLegOdds=MAX_LEG_ODDS){
 const market=[c.betType,c.marketKind,c.marketDesc,c.marketName,c.marketLabel].join(' ');
 const odds=Number(c.odds),p=winningProbability(c);
 return !/correct[ _-]*score|exact[ _-]*(?:match[ _-]*)?score|\bmatch[ _-]*score\b/i.test(market)
  &&Number.isFinite(odds)&&odds>1&&odds<=maxLegOdds
  &&(c.fullWinProbability??c.probability)!=null&&Number.isFinite(p)&&p>=0&&p<=100;
}
function eligible(c,now,dateKey,maxLegOdds=MAX_LEG_ODDS,allowTomorrow=false){
 const start=Date.parse(c.kickoffUtc||''),midnight=Date.parse(dateKey+'T00:00:00+01:00');
 const explicit=c.endTimeUtc||c.finishUtc||c.scheduledEndUtc;
 const sport=require('./telegramMixedSelector').normalizedSport(c);
 const hours={football:3,tennis:Number(c.bestOf||c.liveState?.bestOf)===5?6:4,basketball:4,hockey:4,handball:3,volleyball:4}[sport]||6;
 const finish=explicit?Date.parse(explicit):start+hours*3600000;
 return balancedLeg(c,maxLegOdds)&&Number.isFinite(finish)&&finish>start&&finish<midnight+2*86400000&&!!c.eventId&&c.live!==true&&(c.fullWinProbability??c.probability)!=null&&Number.isFinite(start)&&start>+now+60000&&start>=midnight&&start<midnight+(allowTomorrow?2:1)*86400000&&Number.isFinite(Number(c.odds))&&Number(c.odds)>1;
}
function choose(rows,{targetOdds=TARGET,minimumOdds=MIN_ODDS,maxGames=COUNT,maxLegOdds=MAX_LEG_ODDS,signatures=new Set()}={}){
 const ranked=rows.filter(c=>c.eventId&&balancedLeg(c,maxLegOdds)&&winningProbability(c)>=70)
  .sort((a,b)=>Number(b.odds)-Number(a.odds)||winningProbability(b)-winningProbability(a)||Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc));
 const limit=Math.min(COUNT,maxGames);
 let fallback=[],fallbackOdds=0;
 function build(omit){
  const legs=[],seen=new Set();let odds=1;
  for(const c of ranked){
   if(legs.length>=limit)break;
   const id=String(c.eventId);
   if(id===omit||seen.has(id))continue;
   seen.add(id);legs.push(c);odds*=Number(c.odds);
   if(odds+1e-9>=minimumOdds&&!signatures.has(ticketSignature(legs))){
    if(odds+1e-9>=targetOdds)return legs;
    if(odds>fallbackOdds){fallback=legs.slice();fallbackOdds=odds;}
   }
  }
  return [];
 }
 let best=build();
 if(!best.length&&signatures.size){
  const events=[...new Set(ranked.map(c=>String(c.eventId)))].slice(0,limit);
  for(const id of events){
   const legs=build(id);
   if(legs.length&&(!best.length||legs.length<best.length))best=legs;
  }
 }
 return (best.length?best:fallback).sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc)||winningProbability(b)-winningProbability(a));
}
function message(legs){
 return [...legs].sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc)||winningProbability(b)-winningProbability(a)).map((c,i)=>{
  const name=[c.home,c.away].filter(Boolean).join(' vs ')||c.eventId;
  const market=[c.marketDesc,c.outcomeDesc||c.pick||c.betType].filter(Boolean).join(' · ');
  const start=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Lagos',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(c.kickoffUtc));
  return `${i+1}. ${start} ${String(name).replace(/\s+/g,' ').slice(0,43)} · ${String(market).replace(/\s+/g,' ').slice(0,39)} · ${Number(c.odds).toFixed(2)} · ${winningProbability(c).toFixed(1)}%`;
 }).join('\n');
}
module.exports={PLANS,eligible,choose,message,MIN_ODDS,MAX_LEG_ODDS};
