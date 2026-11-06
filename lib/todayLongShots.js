'use strict';
const {winningProbability,ticketSignature}=require('./telegramNext12h');
const {selectionKey}=require('./sportyPublicCache');
const COUNT=30,TARGET=10000,MIN_ODDS=1000,MAX_LEG_ODDS=2;
const PLANS=Array.from({length:3},(_,i)=>({id:'today10k'+(i+1),label:'TODAY 10,000+ · VARIATION '+(i+1),floor:0,minGames:1,maxGames:COUNT,targetOdds:TARGET,minimumOdds:MIN_ODDS,todayLongShot:true}));
// Use market labels as well as the model key: offered markets can have generic IDs.
function balancedLeg(c,maxLegOdds=MAX_LEG_ODDS){
 const market=[c.betType,c.marketKind,c.marketDesc,c.marketName,c.marketLabel].join(' ');
 const odds=Number(c.odds),p=winningProbability(c);
 return !/correct[ _-]*score|exact[ _-]*(?:match[ _-]*)?score|\bmatch[ _-]*score\b/i.test(market)
  &&Number.isFinite(odds)&&odds>1&&odds<=maxLegOdds
  &&(c.fullWinProbability??c.probability)!=null&&Number.isFinite(p)&&p>=0&&p<=100;
}
function eligible(c,now,dateKey,maxLegOdds=MAX_LEG_ODDS){
 const start=Date.parse(c.kickoffUtc||''),midnight=Date.parse(dateKey+'T00:00:00+01:00');
 const explicit=c.endTimeUtc||c.finishUtc||c.scheduledEndUtc;
 const sport=require('./telegramMixedSelector').normalizedSport(c);
 const hours={football:3,tennis:Number(c.bestOf||c.liveState?.bestOf)===5?6:4,basketball:4,hockey:4,handball:3,volleyball:4}[sport]||6;
 const finish=explicit?Date.parse(explicit):start+hours*3600000;
 return balancedLeg(c,maxLegOdds)&&Number.isFinite(finish)&&finish>start&&finish<midnight+2*86400000&&!!c.eventId&&c.live!==true&&(c.fullWinProbability??c.probability)!=null&&Number.isFinite(start)&&start>+now+60000&&start>=midnight&&start<midnight+86400000&&Number.isFinite(Number(c.odds))&&Number(c.odds)>1;
}
function choose(rows,{now,signatures=new Set(),uses=new Map()}){
 rows=rows.filter(c=>balancedLeg(c));
 const goal=Math.log(TARGET),minimum=Math.log(MIN_ODDS),maxima=new Map();
 for(const c of rows){const id=String(c.eventId);maxima.set(id,Math.max(maxima.get(id)||0,Math.log(c.odds)));}
 const ceiling=[...maxima.values()].sort((a,b)=>b-a).slice(0,COUNT).reduce((a,b)=>a+b,0);
 if(ceiling<=minimum+1e-12)return [];
 const data=rows.map(c=>{
  const p=winningProbability(c)/100;
  const early=Math.max(0,1-(Date.parse(c.kickoffUtc)-+now)/21600000);
  const key=selectionKey(c);
  const odds=Math.log(c.odds);
  const probability=Math.log(Math.max(p,1e-12));
  // Penalize weak early legs and prices far from the per-leg target.
  const value=probability*(1+.65*early)+.35*early*p-2*(odds-goal/COUNT)**2-.12*(uses.get(key)||0);
  return {c,key,odds,value};
 });
 function better(a,b){return !b||a.tier>b.tier||a.tier===b.tier&&(a.count>b.count||a.count===b.count&&a.value>b.value);}
 function sweep(omit){
  let best=null;
  for(const weight of [0,.15,.3,.5,.75,1,1.3,1.7,2.3,3,5,10,30,Infinity]){
   const groups=new Map();
   for(const r of data){
    if(r.key===omit)continue;
    const rank=Number.isFinite(weight)?r.value+weight*r.odds:r.odds;
    const key=String(r.c.eventId),old=groups.get(key);
    if(!old||rank>old.rank||(rank===old.rank&&r.value>old.r.value))groups.set(key,{r,rank});
   }
   const set=[...groups.values()].sort((a,b)=>b.rank-a.rank||b.r.value-a.r.value).slice(0,COUNT).map(x=>x.r);
   let odds=0,value=0;
   for(let i=0;i<set.length;i++){
    odds+=set[i].odds;value+=set[i].value;
    if(odds<=minimum+1e-12)continue;
    const tier=odds+1e-12>=goal?1:0, count=i+1;
    if(!better({tier,count,value},best))continue;
    const legs=set.slice(0,count).map(r=>r.c);
    if(!signatures.has(ticketSignature(legs)))best={legs,tier,count,value};
   }
  }
  return best;
 }
 let best=sweep();
 if((!best||(!best.tier&&ceiling+1e-12>=goal)||best.count<Math.min(COUNT,maxima.size))&&signatures.size){
  // Explore substitutions when the unconstrained sweeps repeat an earlier slip.
  const repeated=new Set(data.filter(r=>uses.has(r.key)).map(r=>r.key));
  for(const key of repeated){const next=sweep(key);if(next&&better(next,best))best=next;}
 }
 return (best?.legs||[]).sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc)||winningProbability(b)-winningProbability(a));
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
