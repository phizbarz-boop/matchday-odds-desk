'use strict';
const sporty=require('./sportybet');
const {selectAutoBet}=require('./autoPicker');
const VIRTUAL_SPORT='sr:sport:202120001';
const names={srl:'Simulated Reality League',virtual:'Virtual Football'};
function product(c){
 const labels=[c.tournament_name,c.tournament?.name,c.tournament,c.category?.name,c.category,c.sport?.name,c.sport,c.home,c.away,c.homeTeamName,c.awayTeamName].filter(x=>typeof x==='string');
 if(labels.some(x=>/\bsrl\b|simulated reality league/i.test(x)))return 'srl';
 if(String(c.sport?.id??c.sportId??'')===VIRTUAL_SPORT||labels.some(x=>/\b(?:vfootball|virtual)\b/i.test(x)))return 'virtual';
 return null;
}
async function loadFixtures(mode,{client=sporty.direct,now=Date.now}={}){
 if(mode!=='srl'&&mode!=='virtual')throw Error('Invalid simulated football product');
 const sportId=mode==='virtual'?VIRTUAL_SPORT:sporty.SPORT_IDS.football;
 const byId=new Map(),seen=new Set();
 for(let page=1;page<=5;page++){
  const payload=await client.fetchPrematchPage(sportId,page,100,{marketIds:'1',timeoutMs:6000});
  const {events,total}=sporty.extractUpcomingEvents(payload);
  let added=0;
  for(const e of events){
   const fixture=sporty.fixtureContext(e,'Football'),id=fixture.eventId;
   if(!id||seen.has(id))continue;
   seen.add(id);added++;
   if(product({...e,...fixture,sport:e.sport,sportId:e.sportId})!==mode||e.banned||fixture.live)continue;
   const kickoffUtc=sporty.normalizeOutcome(e).kickoffUtc;
   if(!(Date.parse(kickoffUtc)>now()+60000))continue;
   const market=(Array.isArray(e.markets)?e.markets:[]).find(m=>String(m.id??m.marketId)==='1'&&!m.specifier&&m.status!==1&&m.active!==false&&m.suspended!==true);
   if(!Array.isArray(market?.outcomes))continue;
   const outcomeIds=['1','2','3'];
   const odds=outcomeIds.map(key=>{
    const o=market.outcomes.find(o=>String(o.id??o.outcomeId)===key);
    return o?.active===false||o?.suspended===true?NaN:Number(o?.odds);
   });
   if(fixture.home&&fixture.away&&odds.every(o=>Number.isFinite(o)&&o>1))byId.set(id,{...fixture,kickoffUtc,odds,marketId:String(market.id??market.marketId),outcomeIds});
  }
  if(!added||events.length<100||(total&&seen.size>=total))break;
 }
 return [...byId.values()];
}
function analyse(rows,{mode,targetOdds,minProbability,maxSelections,maxMatchOdds}){
 const min=Math.max(0,Math.min(95,Number(minProbability)||0)),max=Number(maxMatchOdds);
 const candidates=rows.flatMap(({odds,outcomeIds,...row})=>{
  const total=odds.reduce((sum,n)=>sum+1/n,0);
  return odds.map((price,i)=>{
   const probability=100/price/total;
   return {...row,odds:price,probability,qualityScore:probability,edge:0,outcomeId:outcomeIds[i],pick:['Home win','Draw','Away win'][i]};
  }).filter(c=>c.probability>=min&&(!(max>1)||c.odds<=max));
 });
 const result=selectAutoBet(candidates,{targetOdds,maxSelections:Math.min(20,Math.max(1,parseInt(maxSelections,10)||8)),trials:150});
 return {mode,label:names[mode],selections:result.selections,targetOdds:result.targetOdds,combinedOdds:result.combinedOdds,reachedTarget:result.reachedTarget,fixtureCount:rows.length,candidateCount:candidates.length};
}
function validateTicket(rows,selections,now=Date.now()){
 const byId=new Map(rows.map(r=>[r.eventId,r])),seen=new Set();
 return selections.length>0&&selections.length<=20&&selections.every(s=>{
  if(!s||typeof s!=="object")return false;
  const id=String(s.eventId),r=byId.get(id);
  if(!r||s.live===true||s.specifier||seen.has(id)||Date.parse(r.kickoffUtc)<=now+60000||String(s.marketId)!==r.marketId)return false;
  seen.add(id);
  const price=r.odds[r.outcomeIds.indexOf(String(s.outcomeId))];
  return Number.isFinite(price)&&price===Number(s.odds);
 });
}
module.exports={names,product,loadFixtures,analyse,validateTicket};
