const API_BASE = 'https://v1.handball.api-sports.io';

function apiKey() {
  return process.env.API_SPORTS_KEY || process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL_API_KEY || '';
}

function norm(v) {
  return String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(hc|hk|hsg|bm|handball|club|women|w)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function nameScore(a,b) {
  const x=norm(a), y=norm(b);
  if (!x || !y) return 0;
  if (x===y) return 1;
  if (Math.min(x.length,y.length)>=5 && (x.includes(y)||y.includes(x))) return 0.88;
  const xs=new Set(x.split(' ')), ys=new Set(y.split(' '));
  const inter=[...xs].filter(t=>ys.has(t)).length;
  const union=new Set([...xs,...ys]).size;
  return union ? inter/union : 0;
}

async function apiFetch(path, params={}) {
  const key=apiKey();
  if (!key) {
    const err=new Error('API_SPORTS_KEY/API_FOOTBALL_KEY is not configured');
    err.code='API_SPORTS_KEY_MISSING';
    throw err;
  }
  const u=new URL(`${API_BASE}${path}`);
  Object.entries(params).forEach(([k,v])=>{ if(v!==undefined&&v!==null&&v!=='') u.searchParams.set(k,String(v)); });
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(),15000);
  try {
    const res=await fetch(u,{headers:{'x-apisports-key':key},signal:ctrl.signal});
    if(!res.ok) throw new Error(`API-SPORTS Handball ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

function flattenGames(payload) {
  const rows=Array.isArray(payload?.response)?payload.response:[];
  return rows.map(g=>({
    id:g?.id ?? g?.game?.id ?? null,
    date:g?.date ?? g?.game?.date ?? null,
    timestamp:g?.timestamp ?? g?.game?.timestamp ?? null,
    home:g?.teams?.home?.name ?? g?.home?.name ?? '',
    away:g?.teams?.away?.name ?? g?.away?.name ?? '',
    league:g?.league?.name ?? '',
    country:g?.country?.name ?? g?.league?.country ?? '',
  })).filter(x=>x.home&&x.away);
}

async function getGamesByDate(date) {
  return flattenGames(await apiFetch('/games',{date}));
}

function kickoffMs(row) {
  if (Number.isFinite(Number(row?.timestamp))) return Number(row.timestamp)*1000;
  const d=new Date(row?.date);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function matchOne(sporty, apiGames) {
  let best=null;
  const sk=new Date(sporty?.kickoffTime || sporty?.kickoffUtc || '').getTime();
  for(const g of apiGames||[]) {
    const direct=(nameScore(sporty.homeTeamName||sporty.home,g.home)+nameScore(sporty.awayTeamName||sporty.away,g.away))/2;
    const swapped=(nameScore(sporty.homeTeamName||sporty.home,g.away)+nameScore(sporty.awayTeamName||sporty.away,g.home))/2;
    const names=Math.max(direct,swapped*0.85);
    if(names<0.55) continue;
    const gm=kickoffMs(g);
    const minutes=(Number.isFinite(sk)&&Number.isFinite(gm))?Math.abs(sk-gm)/60000:null;
    const timeScore=minutes===null?0.5:(minutes<=15?1:minutes<=60?0.85:minutes<=180?0.55:0);
    const leagueScore=nameScore(sporty.tournament,g.league);
    const score=names*0.72+timeScore*0.23+leagueScore*0.05;
    if(!best||score>best.score) best={game:g,score,minutes};
  }
  if(!best||best.score<0.68) return null;
  return {
    apiSportsGameId: best.game.id,
    apiSportsHome: best.game.home,
    apiSportsAway: best.game.away,
    apiSportsLeague: best.game.league,
    apiSportsDate: best.game.date,
    apiSportsMatchScore: Math.round(best.score*1000)/1000,
    apiSportsKickoffDiffMinutes: best.minutes===null?null:Math.round(best.minutes),
  };
}

async function matchSnapshot(events,{maxDates=5}={}) {
  const dates=[...new Set((events||[]).map(e=>{
    const d=new Date(e.kickoffTime||e.kickoffUtc||'');
    return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
  }).filter(Boolean))].slice(0,maxDates);

  const byDate=new Map();
  for(const date of dates) {
    try { byDate.set(date,await getGamesByDate(date)); }
    catch(err) { console.warn(`[API-SPORTS Handball] ${date}: ${err.message}`); byDate.set(date,[]); }
  }

  let matched=0;
  const out=(events||[]).map(e=>{
    const d=new Date(e.kickoffTime||e.kickoffUtc||'');
    const key=Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
    const hit=key?matchOne(e,byDate.get(key)||[]):null;
    if(hit) matched++;
    return {...e,...(hit||{}),apiSportsMatched:!!hit};
  });
  return {events:out,matched,total:out.length,datesQueried:dates};
}

module.exports={apiKey,getGamesByDate,matchSnapshot,norm,nameScore};
