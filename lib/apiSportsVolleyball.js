const API_BASE = 'https://v1.volleyball.api-sports.io';

function apiKey() {
  return process.env.API_SPORTS_KEY || process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL_API_KEY || '';
}

const STOP = new Set([
  'hc','hk','hsg','bm','handball','club','team','women','woman','men','male','female',
  'if','il','sk','sc','rk','ks','mks','vc','volley','volleyball','club','team','women','woman','men','male','female'
]);

const REPLACEMENTS = [
  [/\btoender\b/g, 'tonder'],
  [/\bkoebenhavn\b/g, 'copenhagen'],
  [/\bkobenhavn\b/g, 'copenhagen'],
  [/\bgoeppingen\b/g, 'goppingen'],
  [/\bnuernberg\b/g, 'nurnberg'],
  [/\bduesseldorf\b/g, 'dusseldorf'],
  [/\bsaint\b/g, 'st'],
  [/\bsankt\b/g, 'st'],
];

function norm(v) {
  let s = String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();

  for (const [rx, to] of REPLACEMENTS) s = s.replace(rx, to);

  const parts = s.split(' ').filter(Boolean).filter(t => !STOP.has(t));
  return parts.join(' ');
}

function compact(v) {
  return norm(v).replace(/\s+/g, '');
}

function tokens(v) {
  return norm(v).split(' ').filter(Boolean);
}

function dice(a, b) {
  const x = compact(a), y = compact(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (Math.min(x.length, y.length) < 2) return 0;
  const grams = s => {
    const m = new Map();
    for (let i=0;i<s.length-1;i++) {
      const g=s.slice(i,i+2);
      m.set(g,(m.get(g)||0)+1);
    }
    return m;
  };
  const A=grams(x), B=grams(y);
  let inter=0;
  for(const [g,n] of A) inter += Math.min(n,B.get(g)||0);
  const total=[...A.values()].reduce((a,b)=>a+b,0)+[...B.values()].reduce((a,b)=>a+b,0);
  return total ? (2*inter/total) : 0;
}

function tokenScore(a,b) {
  const A=new Set(tokens(a)), B=new Set(tokens(b));
  if(!A.size||!B.size) return 0;
  let inter=0;
  for(const t of A) if(B.has(t)) inter++;
  const j=inter/new Set([...A,...B]).size;
  const contain=[...A].some(x=>[...B].some(y => x.length>=4 && y.length>=4 && (x.includes(y)||y.includes(x)))) ? 0.15 : 0;
  return Math.min(1,j+contain);
}

function nameScore(a,b) {
  const x=norm(a), y=norm(b);
  if(!x||!y) return 0;
  if(x===y) return 1;
  if(compact(x)===compact(y)) return 0.99;
  if(Math.min(x.length,y.length)>=5 && (x.includes(y)||y.includes(x))) return 0.92;
  return Math.max(dice(x,y), tokenScore(x,y));
}

async function apiFetch(path, params={}) {
  const key=apiKey();
  if(!key) {
    const err=new Error('API_SPORTS_KEY/API_FOOTBALL_KEY is not configured');
    err.code='API_SPORTS_KEY_MISSING';
    throw err;
  }
  const u=new URL(`${API_BASE}${path}`);
  Object.entries(params).forEach(([k,v])=>{
    if(v!==undefined&&v!==null&&v!=='') u.searchParams.set(k,String(v));
  });
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(),15000);
  try {
    const res=await fetch(u,{headers:{'x-apisports-key':key},signal:ctrl.signal});
    if(!res.ok) throw new Error(`API-SPORTS Volleyball ${res.status}`);
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
  if(Number.isFinite(Number(row?.timestamp))) return Number(row.timestamp)*1000;
  const d=new Date(row?.date);
  return Number.isNaN(d.getTime())?null:d.getTime();
}

function dayKey(value) {
  const d=new Date(value);
  return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
}

function addDays(dateStr, delta) {
  const d=new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate()+delta);
  return d.toISOString().slice(0,10);
}

function matchOne(sporty, apiGames) {
  let best=null;
  const sk=new Date(sporty?.kickoffTime||sporty?.kickoffUtc||'').getTime();

  for(const g of apiGames||[]) {
    const homeA=sporty.homeTeamName||sporty.home;
    const awayA=sporty.awayTeamName||sporty.away;

    const dHome=nameScore(homeA,g.home);
    const dAway=nameScore(awayA,g.away);
    const direct=(dHome+dAway)/2;

    const rHome=nameScore(homeA,g.away);
    const rAway=nameScore(awayA,g.home);
    const reversed=(rHome+rAway)/2;

    const reversedUsed=reversed>direct;
    const names=reversedUsed ? reversed*0.90 : direct;
    if(names<0.48) continue;

    const gm=kickoffMs(g);
    const minutes=(Number.isFinite(sk)&&Number.isFinite(gm))?Math.abs(sk-gm)/60000:null;
    const timeScore=minutes===null?0.45:(minutes<=15?1:minutes<=45?0.93:minutes<=90?0.80:minutes<=180?0.55:minutes<=360?0.25:0);
    const leagueScore=nameScore(sporty.tournament,g.league);

    // Team names dominate; kickoff is second. League is only a light tie-breaker.
    const score=names*0.74+timeScore*0.23+leagueScore*0.03;

    if(!best||score>best.score) best={
      game:g,score,minutes,reversedUsed,
      directHome:dHome,directAway:dAway
    };
  }

  if(!best||best.score<0.64) return null;

  return {
    apiSportsGameId:best.game.id,
    apiSportsHome:best.game.home,
    apiSportsAway:best.game.away,
    apiSportsLeague:best.game.league,
    apiSportsDate:best.game.date,
    apiSportsMatchScore:Math.round(best.score*1000)/1000,
    apiSportsKickoffDiffMinutes:best.minutes===null?null:Math.round(best.minutes),
    apiSportsOrientationReversed:!!best.reversedUsed,
  };
}

async function matchSnapshot(events,{maxDates=8}={}) {
  const baseDates=[...new Set((events||[]).map(e=>dayKey(e.kickoffTime||e.kickoffUtc)).filter(Boolean))];
  const queryDates=[];
  for(const d of baseDates) {
    for(const x of [addDays(d,-1),d,addDays(d,1)]) {
      if(!queryDates.includes(x)) queryDates.push(x);
    }
  }
  const dates=queryDates.slice(0,Math.max(1,maxDates*3));

  const byDate=new Map();
  for(const date of dates) {
    try { byDate.set(date,await getGamesByDate(date)); }
    catch(err) {
      console.warn(`[API-SPORTS Volleyball] ${date}: ${err.message}`);
      byDate.set(date,[]);
    }
  }

  const out=[];
  let matched=0;
  for(const e of events||[]) {
    const d=dayKey(e.kickoffTime||e.kickoffUtc);
    const candidateDates=d?[addDays(d,-1),d,addDays(d,1)]:[];
    const pool=[];
    for(const key of candidateDates) pool.push(...(byDate.get(key)||[]));
    const hit=matchOne(e,pool);
    if(hit) matched++;
    out.push({...e,...(hit||{}),apiSportsMatched:!!hit});
  }

  return {events:out,matched,total:out.length,datesQueried:dates};
}

module.exports={apiKey,getGamesByDate,matchSnapshot,norm,nameScore};
