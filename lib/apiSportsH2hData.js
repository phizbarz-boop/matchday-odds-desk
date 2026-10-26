'use strict';
const SPORT_HOSTS={football:'https://v3.football.api-sports.io',basketball:'https://v1.basketball.api-sports.io',hockey:'https://v1.hockey.api-sports.io',handball:'https://v1.handball.api-sports.io',volleyball:'https://v1.volleyball.api-sports.io'};
const sportKey=c=>/football|soccer/i.test(c.sport||'')?'football':/basket/i.test(c.sport||'')?'basketball':/hockey/i.test(c.sport||'')?'hockey':/handball/i.test(c.sport||'')?'handball':/volley/i.test(c.sport||'')?'volleyball':null;
const name=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
// Explicit club-name equivalents only. Youth, women, reserve and location
// identifiers are retained; there is no fuzzy-name match for selecting teams.
const FOOTBALL_ALIASES={'afc bournemouth':'bournemouth','leeds united':'leeds','copenhagen':'fc copenhagen'};
function canonicalTeam(value,sport,aliases={}){const normalized=name(value);return name(aliases[normalized]||(sport==='football'?FOOTBALL_ALIASES[normalized]:null)||value);}
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const sum=values=>values.every(v=>number(v)!==null)?values.reduce((a,b)=>a+b,0):null;
const gameDate=g=>g.fixture?.date||g.date;
const gameId=g=>g.fixture?.id??g.id;
function matchFixture(fixtures,c,{aliases={}}={}){
 const canonical=s=>canonicalTeam(s,sportKey(c),aliases),kickoff=Date.parse(c.kickoffUtc);
 if(!canonical(c.home)||!canonical(c.away))return null;
 const found=fixtures.filter(g=>canonical(g.teams?.home?.name)===canonical(c.home)&&canonical(g.teams?.away?.name)===canonical(c.away)&&Number.isFinite(kickoff)&&Math.abs(Date.parse(gameDate(g))-kickoff)<=90*60000);
 if(found.length!==1)return null;const g=found[0];return Number.isInteger(g.teams.home.id)&&Number.isInteger(g.teams.away.id)?g:null;
}
function matchTeam(rows,team,country=null){
 const matches=rows.filter(r=>canonicalTeam(r.team?.name,'football')===canonicalTeam(team,'football')&&Number.isInteger(r.team?.id)&&(!country||name(r.team?.country)===name(country)));
 const unique=[...new Map(matches.map(r=>[r.team.id,r.team])).values()];return unique.length===1?unique[0]:null;
}
function mappingDiagnostics(fixtures,c){
 const tokens=value=>new Set(name(value).split(' ').filter(t=>t.length>=3)),expected=tokens(c.home+' '+c.away);
 const candidates=fixtures.map(g=>({g,rank:[...tokens((g.teams?.home?.name||'')+' '+(g.teams?.away?.name||''))].filter(t=>expected.has(t)).length})).filter(x=>x.rank>0).sort((a,b)=>b.rank-a.rank).slice(0,8).map(({g})=>({providerFixtureId:gameId(g)??null,home:String(g.teams?.home?.name||'').slice(0,160),away:String(g.teams?.away?.name||'').slice(0,160),kickoffUtc:gameDate(g)||null}));
 return{sportyEventId:String(c.eventId),expectedHome:String(c.home).slice(0,160),expectedAway:String(c.away).slice(0,160),expectedKickoffUtc:c.kickoffUtc,providerFixturesReturned:fixtures.length,candidates};
}
function buildEvidence(c,matched,history,{now=new Date(),maxGames=10,statistics=new Map()}={}){
 const sport=sportKey(c),homeId=matched.teams.home.id,awayId=matched.teams.away.id,seen=new Set(),cutoff=Math.min(+now,Date.parse(c.kickoffUtc)||+now),games=[],samples={};
 const add=(metric,value)=>{if(number(value)!==null)(samples[metric]||=[]).push(value);};
 for(const g of [...history].sort((a,b)=>Date.parse(gameDate(b))-Date.parse(gameDate(a)))){
  const date=Date.parse(gameDate(g)),id=String(gameId(g)||''),ids=[g.teams?.home?.id,g.teams?.away?.id],status=g.fixture?.status?.short||g.status?.short;
  if(!id||seen.has(id)||!Number.isFinite(date)||date>=cutoff||!ids.includes(homeId)||!ids.includes(awayId)||ids[0]===ids[1]||!['FT','AOT','AET','PEN'].includes(status))continue;
  seen.add(id);let hs=null,as=null,full=null;
  if(sport==='football'){
   // Fulltime is the regulation score; use goals only for a normal FT finish.
   hs=number(g.score?.fulltime?.home)??(status==='FT'?number(g.goals?.home):null);as=number(g.score?.fulltime?.away)??(status==='FT'?number(g.goals?.away):null);full=sum([hs,as]);
   if(full===null)continue;add('goals',full);add('half_goals',sum([g.score?.halftime?.home,g.score?.halftime?.away]));
   const stats=statistics.get(id);if(Array.isArray(stats)&&stats.length===2&&ids.every(team=>stats.some(s=>s.team?.id===team))){for(const [label,metric] of [['Corner Kicks','corners'],['Shots on Goal','shots_target'],['Yellow Cards','yellow_cards']]){const values=ids.map(team=>stats.find(s=>s.team.id===team)?.statistics?.find(s=>s.type===label)?.value);add(metric,sum(values));}}
  }else if(sport==='basketball'){
   const h=g.scores?.home,a=g.scores?.away;if(!h||!a)continue;hs=number(h.total);as=number(a.total);if(hs===null||as===null)continue;
   add('points_including_overtime',sum([hs,as]));full=sum([h.quarter_1,h.quarter_2,h.quarter_3,h.quarter_4,a.quarter_1,a.quarter_2,a.quarter_3,a.quarter_4]);
   if(full===null&&status==='FT')full=sum([hs,as]);add('points',full);add('half_points',sum([h.quarter_1,h.quarter_2,a.quarter_1,a.quarter_2]));add('quarter_points',sum([h.quarter_1,a.quarter_1]));
  }else{
   hs=number(g.scores?.home);as=number(g.scores?.away);if(hs===null||as===null)continue;
   if(sport==='hockey'){
    // Period strings are home-away scores; never infer regulation from an OT total.
    const periods=['first','second','third'].map(k=>{const m=String(g.periods?.[k]||'').match(/^(\d+)-(\d+)$/);return m?Number(m[1])+Number(m[2]):null;});
    add('goals',sum(periods)??(status==='FT'?sum([hs,as]):null));add('period_goals',periods[0]);
   }else if(sport==='handball'){
    add('goals',status==='FT'?sum([hs,as]):null);add('half_goals',sum([g.periods?.first?.home,g.periods?.first?.away]));
   }else if(sport==='volleyball'){
    // Match scores are SETS, never total points.
    add('sets',sum([hs,as]));const pairs=Object.values(g.periods||{}).filter(p=>p&&typeof p==='object'&&number(p.home)!==null&&number(p.away)!==null&&(p.home+p.away)>0);
    if(pairs.length===hs+as)add('points',sum(pairs.flatMap(p=>[p.home,p.away])));
   }
  }
  games.push({providerGameId:id,date:new Date(date).toISOString(),home:g.teams.home.name,away:g.teams.away.name,homeScore:hs,awayScore:as});if(games.length>=maxGames)break;
 }
 const metrics=Object.fromEntries(Object.entries(samples).filter(([,v])=>v.length).map(([k,v])=>[k,v.reduce((a,b)=>a+b,0)/v.length]));
 if(!games.length||!Object.keys(metrics).length)return null;
 return {eventId:String(c.eventId),home:c.home,away:c.away,sport:c.sport,capturedAt:now.toISOString(),oldAvailable:false,newAvailable:true,provider:'api_sports',providerFixtureId:gameId(matched)==null?null:String(gameId(matched)),providerTeamIds:{home:homeId,away:awayId},mappingBasis:matched.mappingBasis||'scheduled_fixture_and_teams',historyBasis:'direct_head_to_head',metrics,metricSamples:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,v.length])),sampleCount:games.length,samples,games};
}
module.exports={SPORT_HOSTS,sportKey,name,gameDate,gameId,matchFixture,buildEvidence,canonicalTeam,matchTeam,mappingDiagnostics};
