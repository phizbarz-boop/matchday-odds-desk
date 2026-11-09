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
const SRL_LEAGUES=['32215','32219','36215'].map(id=>'sr:tournament:'+id);
function liteEventIds(html){
 const ids=new Set();
 for(const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)){
  try{
   const u=new URL(m[1].replace(/&amp;/g,'&'),'https://www.sportybet.com');
   const id=u.searchParams.get('eventId');
   if(u.origin==='https://www.sportybet.com'&&u.pathname==='/ng/lite/preMatch/detail'&&/^sr:match:\d+$/.test(id||''))ids.add(id);
  }catch{}
 }
 return [...ids];
}
async function discoverLite(tournamentId){
 const url=new URL('https://www.sportybet.com/ng/lite/events');
 url.search=new URLSearchParams({marketId:'1',sportId:'sr:sport:1',productId:'3',tournamentId});
 const r=await fetch(url,{signal:AbortSignal.timeout(6000),redirect:'error'});
 if(!r.ok)throw Error('SportyBet SRL league page unavailable');
 return liteEventIds(await r.text());
}
function openRow(e,mode,now){
 const fixture=sporty.fixtureContext(e,'Football');
 if(!fixture.eventId||product({...e,...fixture,sport:e.sport,sportId:e.sportId})!==mode||e.banned||fixture.live)return null;
 const kickoffUtc=sporty.normalizeOutcome(e).kickoffUtc;
 if(!(Date.parse(kickoffUtc)>now()+60000))return null;
 const rows=sporty.flattenDetailedMarkets(e,fixture).filter(r=>r.marketId==='1'&&!r.specifier);
 const outcomeIds=['1','2','3'];
 const odds=outcomeIds.map(id=>rows.find(r=>r.outcomeId===id)?.odds);
 return odds.every(o=>Number.isFinite(o)&&o>1)?{...fixture,kickoffUtc,odds,marketId:'1',outcomeIds}:null;
}
async function loadFixtures(mode,{client=sporty.direct,now=Date.now,lite=discoverLite,diagnostics={}}={}){
 if(mode!=='srl'&&mode!=='virtual')throw Error('Invalid simulated football product');
 const sportId=mode==='virtual'?VIRTUAL_SPORT:sporty.SPORT_IDS.football;
 const byId=new Map(),detailIds=new Set(),seen=new Set();
 let successes=0,lastError;
 const fetchPage=(page,tournamentId)=>client.fetchPrematchPage(sportId,page,100,{marketIds:'1',timeoutMs:6000,tournamentId});
 const add=events=>{
  let added=0;
  for(const e of events){
   const id=String(e.eventId??e.event_id??'');
   if(!id)continue;
   if(!seen.has(id)){seen.add(id);added++;}
   const row=openRow(e,mode,now);
   if(row)byId.set(id,row);
   else if(mode==='srl'&&product(e)==='srl'&&!e.banned&&!sporty.isLiveEvent(e)&&Date.parse(sporty.normalizeOutcome(e).kickoffUtc)>now()+60000)detailIds.add(id);
  }
  return added;
 };
 const read=async(page,tournamentId)=>{
  try{const data=sporty.extractUpcomingEvents(await fetchPage(page,tournamentId));successes++;return {...data,added:add(data.events)};}
  catch(e){lastError=e;return null;}
 };
 const first=await read(1);
 if(mode==='srl'&&byId.size<8){
  await Promise.all(SRL_LEAGUES.map(id=>read(1,id)));
  if(byId.size<8&&first?.added&&(!first.total||first.total>first.events.length)){
   for(let start=2;start<=10&&byId.size<8;start+=3){
    const batch=await Promise.all([start,start+1,start+2].filter(p=>p<=10).map(p=>read(p)));
    if(batch.every(x=>!x?.added))break;
   }
  }
 }else if(mode==='virtual'&&first?.added){
  let pageData=first;
  for(let page=2;page<=5&&pageData?.added&&pageData.events.length>=100&&(!pageData.total||seen.size<pageData.total);page++)pageData=await read(page);
 }
 if(mode==='srl'&&!byId.size&&typeof client.fetchEventDetail==='function'){
  if(detailIds.size<8){
   const pages=await Promise.allSettled(SRL_LEAGUES.map(lite));
   for(const p of pages)if(p.status==='fulfilled')for(const id of p.value)detailIds.add(id);
  }
  await Promise.allSettled([...detailIds].slice(0,12).map(async id=>{
   const payload=await client.fetchEventDetail(id),data=payload?.data??payload,e=data?.event??data;
   if(String(e?.eventId??e?.event_id)!==id)return;
   add([e]);
  }));
 }
 Object.assign(diagnostics,{fixturesRead:seen.size,openFixtures:byId.size,detailCandidates:detailIds.size,feedReads:successes});
 if(!successes&&!byId.size&&lastError)throw lastError;
 return [...byId.values()];
}
function analyse(rows,{mode,targetOdds,minProbability,maxSelections,maxMatchOdds,excludedEventIds}){
 const min=Math.max(0,Math.min(95,Number(minProbability)||0)),max=Number(maxMatchOdds);
 const excluded=new Set(Array.isArray(excludedEventIds)?excludedEventIds.slice(0,100).filter(id=>typeof id==='string'&&id.length<=100):[]);
 const candidates=rows.flatMap(({odds,outcomeIds,...row})=>{
  if(excluded.has(String(row.eventId)))return [];
  const total=odds.reduce((sum,n)=>sum+1/n,0);
  return odds.map((price,i)=>{
   const probability=100/price/total;
   return {...row,odds:price,probability,qualityScore:probability,edge:0,outcomeId:outcomeIds[i],pick:['Home win','Draw','Away win'][i]};
  }).filter(c=>c.probability>=min&&(!(max>1)||c.odds<=max));
 });
 const result=selectAutoBet(candidates,{targetOdds,maxSelections:Math.min(20,Math.max(1,parseInt(maxSelections,10)||8)),trials:150});
 return {mode,label:names[mode],selections:result.selections,targetOdds:result.targetOdds,combinedOdds:result.combinedOdds,reachedTarget:result.reachedTarget,fixtureCount:rows.length,excludedFixtureCount:rows.filter(r=>excluded.has(String(r.eventId))).length,candidateCount:candidates.length};
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
