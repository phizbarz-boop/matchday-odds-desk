'use strict';
const {sameTeam}=require('./apiSportsH2hData');
const BASE='https://site.api.espn.com/apis/site/v2/sports/soccer/all';
const numeric=id=>/^\d+$/.test(String(id||''));
const side=(game,role)=>game?.competitors?.find(t=>t.homeAway===role)?.team;
const teams=game=>['home','away'].map(role=>side(game,role));
const near=(a,b,minutes)=>Number.isFinite(Date.parse(a))&&Number.isFinite(Date.parse(b))&&Math.abs(Date.parse(a)-Date.parse(b))<=minutes*60000;
function matchFixture(board,c){
 const matches=(board?.events||[]).flatMap(e=>e.competitions||[]).filter(g=>numeric(g.id)&&g.timeValid!==false&&near(g.date,c.kickoffUtc,30)&&['home','away'].every(role=>{
  const t=side(g,role);return numeric(t?.id)&&[t.displayName,t.name].some(n=>n&&sameTeam(n,c[role],'football'));
 }));
 const unique=new Map(matches.map(g=>[String(g.id),g]));
 return unique.size===1?[...unique.values()][0]:null;
}
function starters(data,teamId,basis){
 const rosters=(data?.rosters||[]).filter(r=>String(r.team?.id)===String(teamId));
 if(rosters.length!==1)return null;
 const rows=(rosters[0].roster||[]).filter(p=>p.starter===true).map(p=>({
  id:String(p.athlete?.id||''),name:p.athlete?.fullName||p.athlete?.displayName,
  position:p.position?.displayName||p.position?.name||null,teamId:String(teamId),provider:'espn',basis,
  startingLineupConfirmed:basis==='confirmed'
 }));
 return rows.length===11&&rows.every(p=>numeric(p.id)&&p.name)&&new Set(rows.map(p=>p.id)).size===11?rows:null;
}
async function fetchJson(url){
 const response=await fetch(url,{signal:AbortSignal.timeout(10000),redirect:'error',headers:{Accept:'application/json'}});
 if(!response.ok)throw Error('ESPN_HTTP_'+response.status);
 return response.json();
}
function createCollector({request=fetchJson,now=Date.now}={}){
 const cache=new Map();
 function load(key,path){
  if(!cache.has(key)){
   if(cache.size>=120)cache.delete(cache.keys().next().value);
   cache.set(key,Promise.resolve().then(()=>request(BASE+path)).catch(error=>{cache.delete(key);throw error;}));
  }
  return cache.get(key);
 }
 const summary=id=>load('summary:'+id,'/summary?event='+id);
 return async c=>{
  const kickoff=Date.parse(c.kickoffUtc);
  if(!Number.isFinite(kickoff)||kickoff<=now())return null;
  const date=new Date(kickoff).toISOString().slice(0,10).replaceAll('-','');
  const g=matchFixture(await load('board:'+date,'/scoreboard?dates='+date+'&limit=1000'),c);
  if(!g)return null;
  const data=await summary(g.id),detail=data?.header?.competitions?.[0],ids=teams(g).map(t=>String(t.id));
  if(String(detail?.id)!==String(g.id)||!near(detail?.date,g.date,1)||teams(detail).some((t,i)=>String(t?.id)!==ids[i]))return null;
  const confirmed=ids.map(id=>starters(data,id,'confirmed'));
  const rows=confirmed.every(Boolean)?confirmed:await Promise.all(ids.map(async (id,i)=>{
   // When only one current XI is present, use both teams' recent evidence
   // consistently; never present an incomplete current lineup as confirmed.
   const latest=data.lastFiveGames?.find(r=>String(r.team?.id)===id)?.events?.filter(e=>numeric(e.id)&&String(e.id)!==String(g.id)&&[e.homeTeamId,e.awayTeamId].map(String).includes(id)&&Date.parse(e.gameDate)<now()&&Date.parse(e.gameDate)>=now()-21*86400000).sort((a,b)=>Date.parse(b.gameDate)-Date.parse(a.gameDate))[0];
   if(!latest)return null;
   const previous=await summary(latest.id),match=previous?.header?.competitions?.[0];
   if(String(match?.id)!==String(latest.id)||!near(match?.date,latest.gameDate,1)||match.status?.type?.completed!==true||teams(match).some((t,n)=>String(t?.id)!==String(n?latest.awayTeamId:latest.homeTeamId)))return null;
   return starters(previous,id,'usual')?.map(p=>({...p,historyDate:latest.gameDate,historyEventId:String(latest.id)}))||null;
  }));
  if(!rows.every(Boolean))return null;
  const basis=confirmed.every(Boolean)?'confirmed':'usual';
  return {eventId:String(c.eventId),home:c.home,away:c.away,kickoffUtc:c.kickoffUtc,capturedAt:new Date(now()).toISOString(),provider:'espn',basis,startingLineupConfirmed:basis==='confirmed',players:rows.flat()};
 };
}
module.exports={createCollector,matchFixture,starters};
