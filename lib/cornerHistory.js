// Historical corner engine for Matchday Odds Desk.
// Builds/caches one completed season per league from API-Football and derives
// full-time + first-half empirical hit rates for upcoming matchups.

const fs = require('fs');
const path = require('path');
const { apiFetch } = require('./apiFootball');

const MEMORY = new Map();
let redisClient = null;

function round2(n){ return Math.round(Number(n) * 100) / 100; }
function round1(n){ return Math.round(Number(n) * 10) / 10; }
function clamp(n,lo,hi){ return Math.min(hi,Math.max(lo,n)); }

async function getRedis(){
  if (!process.env.REDIS_URL) return null;
  if (redisClient) return redisClient;
  const { createClient } = require('redis');
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', e => console.warn('[CornerHistory Redis]', e.message));
  await redisClient.connect();
  return redisClient;
}

function historyKey(leagueId, season){
  return `corner-history:v3:${Number(leagueId)}:${Number(season)}`;
}

function localHistoryPath(leagueId, season){
  return path.join(__dirname, '..', 'data', `corner-history-${Number(leagueId)}-${Number(season)}.json`);
}

async function loadHistory(leagueId, season){
  const key = historyKey(leagueId, season);
  if (MEMORY.has(key)) return MEMORY.get(key);
  const redis = await getRedis();
  if (redis){
    const raw = await redis.get(key);
    if (raw){
      try { const parsed=JSON.parse(raw); MEMORY.set(key,parsed); return parsed; } catch {}
    }
  }
  const file = localHistoryPath(leagueId, season);
  if (fs.existsSync(file)){
    try { const parsed=JSON.parse(fs.readFileSync(file,'utf8')); MEMORY.set(key,parsed); return parsed; } catch {}
  }
  return null;
}

async function saveHistory(history){
  const key = historyKey(history.leagueId, history.season);
  MEMORY.set(key, history);
  const redis = await getRedis();
  if (redis){
    // Historical data is immutable after the season is complete; keep without TTL.
    await redis.set(key, JSON.stringify(history));
  } else {
    const file = localHistoryPath(history.leagueId, history.season);
    fs.mkdirSync(path.dirname(file), { recursive:true });
    fs.writeFileSync(file, JSON.stringify(history, null, 2));
  }
  return history;
}

function periodFromText(v){
  const s=String(v||'').toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim();
  if (!s) return null;
  if (/first|1st|\b1h\b|half 1|period 1|^1$/.test(s)) return 'h1';
  if (/second|2nd|\b2h\b|half 2|period 2|^2$/.test(s)) return 'h2';
  if (/full|total|match|all|90/.test(s)) return 'ft';
  return null;
}

function numeric(v){
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace('%','').trim());
  return Number.isFinite(n) ? n : null;
}

// API-Football's half=true response has changed shape across documentation builds.
// This recursive parser intentionally accepts both the normal team/statistics array
// and nested period/half variants. It records only Corner Kicks.
function extractCornerPeriods(response){
  const out = new Map();
  const ensure = id => {
    const k=String(id||'');
    if(!k) return null;
    if(!out.has(k)) out.set(k,{ft:null,h1:null,h2:null});
    return out.get(k);
  };

  function walk(node, ctx={teamId:null,period:null}){
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { for(const x of node) walk(x,ctx); return; }
    if (typeof node !== 'object') return;

    let teamId = ctx.teamId;
    if (node.team && typeof node.team === 'object' && node.team.id !== undefined) teamId = node.team.id;
    if (node.team_id !== undefined) teamId = node.team_id;

    let period = ctx.period;
    for (const k of ['period','half','time','segment','name']){
      const p = periodFromText(node[k]);
      if (p) { period=p; break; }
    }

    const type = String(node.type || node.stat || node.statistic || '').toLowerCase();
    if (type === 'corner kicks' || type === 'corners' || type.includes('corner kick')){
      const rec=ensure(teamId);
      if(rec){
        const v = numeric(node.value ?? node.total ?? node.count);
        if(v !== null) rec[period || 'ft'] = v;
        // Also support a nested value object: {total, first, second}.
        if (node.value && typeof node.value === 'object'){
          for(const [k,val] of Object.entries(node.value)){
            const p=periodFromText(k);
            const n=numeric(val);
            if(p&&n!==null) rec[p]=n;
          }
        }
      }
    }

    for (const [k,v] of Object.entries(node)){
      if (['team','type','stat','statistic','value','total','count'].includes(k)) continue;
      const p=periodFromText(k);
      walk(v,{teamId,period:p||period});
    }
  }

  walk(response);
  return out;
}

function fixtureCornerRow(fx, statsResponse){
  const homeId=Number(fx?.teams?.home?.id), awayId=Number(fx?.teams?.away?.id);
  if(!homeId||!awayId) return null;
  const byTeam=extractCornerPeriods(statsResponse);
  const h=byTeam.get(String(homeId)), a=byTeam.get(String(awayId));
  if(!h||!a||!Number.isFinite(h.ft)||!Number.isFinite(a.ft)) return null;
  const row={
    fixtureId:Number(fx?.fixture?.id),
    date:fx?.fixture?.date||null,
    round:fx?.league?.round||'',
    homeTeamId:homeId, home:fx?.teams?.home?.name||'',
    awayTeamId:awayId, away:fx?.teams?.away?.name||'',
    ft:{home:h.ft,away:a.ft,total:h.ft+a.ft},
    h1:null,
    h2:null,
  };
  if(Number.isFinite(h.h1)&&Number.isFinite(a.h1)) row.h1={home:h.h1,away:a.h1,total:h.h1+a.h1};
  if(Number.isFinite(h.h2)&&Number.isFinite(a.h2)) row.h2={home:h.h2,away:a.h2,total:h.h2+a.h2};
  else if(row.h1) row.h2={home:Math.max(0,h.ft-h.h1),away:Math.max(0,a.ft-a.h1),total:Math.max(0,h.ft+a.ft-h.h1-a.h1)};
  return row;
}

async function buildLeagueHistory(leagueId, season, {force=false, maxFixtures=null, onProgress=null}={}){
  leagueId=Number(leagueId); season=Number(season);
  if(!leagueId||!season) throw new Error('leagueId and season are required');
  if(!force){ const cached=await loadHistory(leagueId,season); if(cached) return cached; }

  // Check coverage first so a league without fixture statistics does not consume
  // one statistics request per fixture only to return empty data.
  try{
    const meta=await apiFetch('/leagues',{id:leagueId,season});
    const leagueRow=Array.isArray(meta.response)?meta.response[0]:null;
    const seasonRow=(leagueRow?.seasons||[]).find(x=>Number(x?.year)===season);
    if(seasonRow?.coverage?.fixtures?.statistics_fixtures===false){
      throw new Error(`Fixture statistics are not covered for league ${leagueId}, season ${season}`);
    }
  }catch(e){
    if(/not covered/i.test(e.message)) throw e;
    console.warn(`[CornerHistory] coverage check league ${leagueId}: ${e.message}; continuing with fixture probe`);
  }

  const j=await apiFetch('/fixtures',{league:leagueId,season,timezone:'UTC'});
  const finished=new Set(['FT','AET','PEN']);
  let fixtures=(Array.isArray(j.response)?j.response:[]).filter(x=>finished.has(String(x?.fixture?.status?.short||'')));
  if(Number.isFinite(Number(maxFixtures))&&Number(maxFixtures)>0) fixtures=fixtures.slice(0,Number(maxFixtures));
  if(!fixtures.length) throw new Error(`No completed fixtures found for league ${leagueId}, season ${season}`);

  const rows=[]; let failed=0;
  for(let i=0;i<fixtures.length;i++){
    const fx=fixtures[i];
    try{
      // half=true returns full-time + half splits for seasons with coverage (2024+).
      const s=await apiFetch('/fixtures/statistics',{fixture:fx.fixture.id,half:true});
      const row=fixtureCornerRow(fx,Array.isArray(s.response)?s.response:[]);
      if(row) rows.push(row); else failed++;
    }catch(e){
      failed++;
      console.warn(`[CornerHistory] fixture ${fx?.fixture?.id}: ${e.message}`);
    }
    if(onProgress && (i===fixtures.length-1 || i%20===0)) onProgress({done:i+1,total:fixtures.length,usable:rows.length,failed});
  }

  const history={
    version:3,
    leagueId,
    leagueName:fixtures[0]?.league?.name||'',
    country:fixtures[0]?.league?.country||'',
    season,
    generatedAt:new Date().toISOString(),
    fixtureCount:fixtures.length,
    usableMatches:rows.length,
    firstHalfUsableMatches:rows.filter(x=>x.h1).length,
    failedMatches:failed,
    matches:rows,
  };
  return saveHistory(history);
}

function mean(arr){ return arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:null; }
function hit(arr, pred){ return arr.length ? arr.filter(pred).length/arr.length*100 : null; }

function teamRows(history, teamId, venue='all'){
  teamId=Number(teamId);
  return (history?.matches||[]).filter(m=>{
    if(venue==='home') return m.homeTeamId===teamId;
    if(venue==='away') return m.awayTeamId===teamId;
    return m.homeTeamId===teamId || m.awayTeamId===teamId;
  });
}

function profileTeam(history, teamId, venue='all'){
  const rows=teamRows(history,teamId,venue);
  if(!rows.length) return null;
  const ftFor=[],ftAgainst=[],ftTotal=[],h1For=[],h1Against=[],h1Total=[];
  for(const m of rows){
    const isHome=m.homeTeamId===Number(teamId);
    ftFor.push(isHome?m.ft.home:m.ft.away);
    ftAgainst.push(isHome?m.ft.away:m.ft.home);
    ftTotal.push(m.ft.total);
    if(m.h1){h1For.push(isHome?m.h1.home:m.h1.away);h1Against.push(isHome?m.h1.away:m.h1.home);h1Total.push(m.h1.total);}
  }
  return {
    samples:rows.length, firstHalfSamples:h1For.length,
    cornersFor:round2(mean(ftFor)), cornersAgainst:round2(mean(ftAgainst)), totalCorners:round2(mean(ftTotal)),
    firstHalfCornersFor:h1For.length?round2(mean(h1For)):null,
    firstHalfCornersAgainst:h1Against.length?round2(mean(h1Against)):null,
    firstHalfTotalCorners:h1Total.length?round2(mean(h1Total)):null,
    matchHitRates:{
      over65:round1(hit(ftTotal,x=>x>=7)), over75:round1(hit(ftTotal,x=>x>=8)), over85:round1(hit(ftTotal,x=>x>=9)), over95:round1(hit(ftTotal,x=>x>=10)),
      under125:round1(hit(ftTotal,x=>x<=12)), under135:round1(hit(ftTotal,x=>x<=13)),
    },
    teamHitRates:{
      over15:round1(hit(ftFor,x=>x>=2)), over25:round1(hit(ftFor,x=>x>=3)), over35:round1(hit(ftFor,x=>x>=4)), over45:round1(hit(ftFor,x=>x>=5)),
    },
    opponentHitRates:{
      over15:round1(hit(ftAgainst,x=>x>=2)), over25:round1(hit(ftAgainst,x=>x>=3)), over35:round1(hit(ftAgainst,x=>x>=4)), over45:round1(hit(ftAgainst,x=>x>=5)),
    },
    firstHalfTeamHitRates:h1For.length?{
      over05:round1(hit(h1For,x=>x>=1)), over15:round1(hit(h1For,x=>x>=2)), over25:round1(hit(h1For,x=>x>=3)), over35:round1(hit(h1For,x=>x>=4)), over45:round1(hit(h1For,x=>x>=5)),
    }:null,
    firstHalfOpponentHitRates:h1Against.length?{
      over05:round1(hit(h1Against,x=>x>=1)), over15:round1(hit(h1Against,x=>x>=2)), over25:round1(hit(h1Against,x=>x>=3)), over35:round1(hit(h1Against,x=>x>=4)), over45:round1(hit(h1Against,x=>x>=5)),
    }:null,
    firstHalfMatchHitRates:h1Total.length?{
      over25:round1(hit(h1Total,x=>x>=3)), over35:round1(hit(h1Total,x=>x>=4)), over45:round1(hit(h1Total,x=>x>=5)), over55:round1(hit(h1Total,x=>x>=6)),
    }:null,
  };
}

function avgMaybe(...vals){ const a=vals.map(Number).filter(Number.isFinite); return a.length?mean(a):null; }

function matchupFromHistory(history, homeTeamId, awayTeamId){
  if(!history) return null;
  const hAll=profileTeam(history,homeTeamId,'all');
  const aAll=profileTeam(history,awayTeamId,'all');
  const hHome=profileTeam(history,homeTeamId,'home')||hAll;
  const aAway=profileTeam(history,awayTeamId,'away')||aAll;
  if(!hAll||!aAll) return null;

  // Historical empirical matchup expectations combine venue-specific attacking and
  // opponent-conceded profiles. These are later blended with recent-form lambdas.
  const homeFor=avgMaybe(hHome?.cornersFor,aAway?.cornersAgainst,hAll?.cornersFor,aAll?.cornersAgainst);
  const awayFor=avgMaybe(aAway?.cornersFor,hHome?.cornersAgainst,aAll?.cornersFor,hAll?.cornersAgainst);
  const h1HomeFor=avgMaybe(hHome?.firstHalfCornersFor,aAway?.firstHalfCornersAgainst,hAll?.firstHalfCornersFor,aAll?.firstHalfCornersAgainst);
  const h1AwayFor=avgMaybe(aAway?.firstHalfCornersFor,hHome?.firstHalfCornersAgainst,aAll?.firstHalfCornersFor,hAll?.firstHalfCornersAgainst);

  const matchRate=(key)=>avgMaybe(hHome?.matchHitRates?.[key],aAway?.matchHitRates?.[key],hAll?.matchHitRates?.[key],aAll?.matchHitRates?.[key]);
  // Team-line empirical rates combine the team's own hit-rate with how often the
  // opponent concedes that same threshold. This is stronger than comparing two teams'
  // attacking hit-rates, which was the old approximation.
  const homeTeamRate=(key)=>avgMaybe(hHome?.teamHitRates?.[key],hAll?.teamHitRates?.[key],aAway?.opponentHitRates?.[key],aAll?.opponentHitRates?.[key]);
  const awayTeamRate=(key)=>avgMaybe(aAway?.teamHitRates?.[key],aAll?.teamHitRates?.[key],hHome?.opponentHitRates?.[key],hAll?.opponentHitRates?.[key]);
  const h1HomeRate=(key)=>avgMaybe(hHome?.firstHalfTeamHitRates?.[key],hAll?.firstHalfTeamHitRates?.[key],aAway?.firstHalfOpponentHitRates?.[key],aAll?.firstHalfOpponentHitRates?.[key]);
  const h1AwayRate=(key)=>avgMaybe(aAway?.firstHalfTeamHitRates?.[key],aAll?.firstHalfTeamHitRates?.[key],hHome?.firstHalfOpponentHitRates?.[key],hAll?.firstHalfOpponentHitRates?.[key]);

  const leagueTotals=(history.matches||[]).map(x=>Number(x?.ft?.total)).filter(Number.isFinite);
  const leagueH1Totals=(history.matches||[]).map(x=>Number(x?.h1?.total)).filter(Number.isFinite);
  return {
    leagueId:history.leagueId, season:history.season,
    leagueAvgTotal:round2(mean(leagueTotals)),
    leagueAvgFirstHalf:leagueH1Totals.length?round2(mean(leagueH1Totals)):null,
    samplesHome:hAll.samples, samplesAway:aAll.samples,
    venueSamplesHome:hHome?.samples||0, venueSamplesAway:aAway?.samples||0,
    firstHalfSamplesHome:hAll.firstHalfSamples, firstHalfSamplesAway:aAll.firstHalfSamples,
    homeExpected:round2(homeFor), awayExpected:round2(awayFor), totalExpected:round2((homeFor||0)+(awayFor||0)),
    firstHalfHomeExpected:Number.isFinite(h1HomeFor)?round2(h1HomeFor):null,
    firstHalfAwayExpected:Number.isFinite(h1AwayFor)?round2(h1AwayFor):null,
    firstHalfTotalExpected:Number.isFinite(h1HomeFor)&&Number.isFinite(h1AwayFor)?round2(h1HomeFor+h1AwayFor):null,
    matchHitRates:{
      over65:round1(matchRate('over65')),over75:round1(matchRate('over75')),over85:round1(matchRate('over85')),over95:round1(matchRate('over95')),
      under125:round1(matchRate('under125')),under135:round1(matchRate('under135')),
    },
    homeTeamHitRates:{over15:round1(homeTeamRate('over15')),over25:round1(homeTeamRate('over25')),over35:round1(homeTeamRate('over35')),over45:round1(homeTeamRate('over45'))},
    awayTeamHitRates:{over15:round1(awayTeamRate('over15')),over25:round1(awayTeamRate('over25')),over35:round1(awayTeamRate('over35')),over45:round1(awayTeamRate('over45'))},
    firstHalfHomeHitRates:h1HomeFor===null?null:{over05:round1(h1HomeRate('over05')),over15:round1(h1HomeRate('over15')),over25:round1(h1HomeRate('over25')),over35:round1(h1HomeRate('over35')),over45:round1(h1HomeRate('over45'))},
    firstHalfAwayHitRates:h1AwayFor===null?null:{over05:round1(h1AwayRate('over05')),over15:round1(h1AwayRate('over15')),over25:round1(h1AwayRate('over25')),over35:round1(h1AwayRate('over35')),over45:round1(h1AwayRate('over45'))},
  };
}

function lineKey(line,isOver=true){
  const l=Number(line);
  if(isOver && Math.abs(l-6.5)<.01) return 'over65';
  if(isOver && Math.abs(l-7.5)<.01) return 'over75';
  if(isOver && Math.abs(l-8.5)<.01) return 'over85';
  if(isOver && Math.abs(l-9.5)<.01) return 'over95';
  if(!isOver && Math.abs(l-12.5)<.01) return 'under125';
  if(!isOver && Math.abs(l-13.5)<.01) return 'under135';
  return null;
}

function teamLineKey(line,isOver=true){
  if(!isOver) return null;
  const l=Number(line);
  if(Math.abs(l-1.5)<.01) return 'over15';
  if(Math.abs(l-2.5)<.01) return 'over25';
  if(Math.abs(l-3.5)<.01) return 'over35';
  if(Math.abs(l-4.5)<.01) return 'over45';
  return null;
}

module.exports={
  historyKey,loadHistory,saveHistory,buildLeagueHistory,extractCornerPeriods,fixtureCornerRow,
  profileTeam,matchupFromHistory,lineKey,teamLineKey,
};
