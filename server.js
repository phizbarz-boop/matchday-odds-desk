const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // Render forwards the real client IP.
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'predictions.json');
const { getFootballMarket, getSportMarket, getBooking, bookBet, SPORT_CONFIG } = require('./lib/sportybet');
const { buildCandidates, selectAutoBet } = require('./lib/autoPicker');
const { sendTelegramMessage } = require('./lib/telegram');
const { trackTelegramSlip, listTrackedSlips, updateTrackedSlip, evaluateBooking } = require('./lib/slipTracker');
const { apiFetch, enrichSportyFixtures } = require('./lib/apiFootball');

let redisClient = null;
async function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (redisClient) return redisClient;
  const { createClient } = require('redis');
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (e) => console.error('Redis error', e.message));
  await redisClient.connect();
  return redisClient;
}


const sportyMemoryCache = new Map();
const bookingMemoryRate = new Map();
const telegramSendMemory = new Map();



function sanitizeTelegramSlip(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 30).map(x => ({
    sport: String(x?.sport || '').slice(0, 30),
    home: String(x?.home || '').slice(0, 120),
    away: String(x?.away || '').slice(0, 120),
    tournament: String(x?.tournament || '').slice(0, 120),
    marketDesc: String(x?.marketDesc || '').slice(0, 120),
    outcomeDesc: String(x?.outcomeDesc || '').slice(0, 120),
    odds: Number(x?.odds) || null,
    probability: Number(x?.probability) || null,
    impliedProbability: Number(x?.impliedProbability) || null,
    edge: Number(x?.edge) || 0,
    expectedValuePct: Number(x?.expectedValuePct) || 0,
    marketReliability: Number(x?.marketReliability) || null,
    qualityScore: Number(x?.qualityScore) || null,
    edgeType: String(x?.edgeType || '').slice(0, 40),
    fairOdds: Number(x?.fairOdds) || null,
    fullWinProbability: Number(x?.fullWinProbability) || null,
    nonLossProbability: Number(x?.nonLossProbability) || null,
    settlementNote: String(x?.settlementNote || '').slice(0, 100),
    specifier: x?.specifier ? String(x.specifier).slice(0, 120) : null,
  }));
}

async function createTelegramSendToken(payload) {
  const token = crypto.randomBytes(24).toString('hex');
  const key = `telegram:websend:${token}`;
  const client = await getRedis();
  const ttl = 600;
  if (client) {
    await client.set(key, JSON.stringify(payload), { EX: ttl });
  } else {
    telegramSendMemory.set(key, { payload, expiresAt: Date.now() + ttl * 1000 });
  }
  return token;
}

async function consumeTelegramSendToken(token) {
  if (!token) return null;
  const key = `telegram:websend:${String(token)}`;
  const client = await getRedis();
  if (client) {
    const raw = await client.get(key);
    if (!raw) return null;
    await client.del(key);
    return JSON.parse(raw);
  }
  const hit = telegramSendMemory.get(key);
  if (!hit) return null;
  telegramSendMemory.delete(key);
  if (hit.expiresAt < Date.now()) return null;
  return hit.payload;
}

function telegramManualSlipText(payload) {
  const slip = Array.isArray(payload?.slip) ? payload.slip : [];
  const combined = slip.reduce((p, x) => p * (Number(x.odds) || 1), 1);
  const probs = slip.map(x => Number(x.probability)).filter(Number.isFinite);
  const avg = probs.length ? probs.reduce((a,b)=>a+b,0)/probs.length : null;
  const slipProb = probs.length === slip.length && slip.length ? probs.reduce((p,x)=>p*(x/100),1)*100 : null;
  const avgEdge = slip.length ? slip.reduce((a,x)=>a+(Number(x.edge)||0),0)/slip.length : null;
  const avgQuality = slip.map(x=>Number(x.qualityScore)).filter(Number.isFinite);
  const avgQ = avgQuality.length ? avgQuality.reduce((a,b)=>a+b,0)/avgQuality.length : null;
  const lines = [
    '📲 MATCHDAY ODDS DESK — MANUAL SHARE',
    `SportyBet code: ${payload?.shareCode || 'N/A'}`,
    `Combined odds: ${combined.toFixed(2)}`,
    `Selections: ${slip.length}`,
    ...(avg !== null ? [`Average leg probability: ${avg.toFixed(1)}%`] : []),
    ...(slipProb !== null ? [`Estimated slip fair-price probability: ${slipProb.toFixed(3)}%`] : []),
    ...(avgEdge !== null ? [`Average probability edge: ${avgEdge.toFixed(1)} pts`] : []),
    ...(avgQ !== null ? [`Average quality score: ${avgQ.toFixed(1)}/100`] : []),
    '',
  ];
  slip.forEach((x, i) => {
    lines.push(`${i + 1}. [${x.sport || 'Sport'}] ${x.home} vs ${x.away}`);
    lines.push(`   ${x.outcomeDesc || x.marketDesc || 'Selection'} @ ${Number(x.odds || 0).toFixed(2)}${Number.isFinite(Number(x.probability)) ? ` | model/fair ${Number(x.probability).toFixed(1)}%` : ''}${Number.isFinite(Number(x.impliedProbability)) ? ` | implied ${Number(x.impliedProbability).toFixed(1)}%` : ''}${Number.isFinite(Number(x.edge)) ? ` | edge ${Number(x.edge).toFixed(1)}` : ''}${Number.isFinite(Number(x.qualityScore)) ? ` | Q ${Number(x.qualityScore).toFixed(1)}` : ''}`);
    if (x.settlementNote && x.settlementNote !== 'Win/lose market') lines.push(`   Settlement: ${x.settlementNote}${Number.isFinite(Number(x.fullWinProbability)) ? ` | full-win ${Number(x.fullWinProbability).toFixed(1)}%` : ''}${Number.isFinite(Number(x.nonLossProbability)) ? ` | non-loss ${Number(x.nonLossProbability).toFixed(1)}%` : ''}`);
  });
  if (payload?.shareURL) lines.push('', `SportyBet link: ${payload.shareURL}`);
  return lines.join('\n');
}

async function loadSportyBetMarket(kind, sport = 'football', options = {}) {
  const ttlSeconds = Math.max(60, parseInt(process.env.SPORTYBET_CACHE_SECONDS || '43200', 10));
  const normalHours = Math.max(1, parseInt(process.env.SPORTYBET_HOURS || String((parseInt(process.env.DAYS_AHEAD || '4', 10) + 1) * 24), 10));
  const hours = Math.max(1, Math.min(24 * 21, parseInt(options.hours || normalHours, 10)));
  const maxPages = Math.max(1, Math.min(20, parseInt(options.maxPages || process.env.SPORTYBET_MAX_PAGES || '5', 10)));
  // Keep Analyzer's 14/21-day cache completely separate from the normal Auto Builder cache.
  // Versioned cache key: bumping this invalidates stale/empty market caches after parser changes.
  const cacheVersion = String(process.env.SPORTYBET_CACHE_VERSION || '4');
  const cacheKey = `sportybet:v${cacheVersion}:${sport}:${kind}:h${hours}:p${maxPages}`;
  const client = await getRedis();

  if (client) {
    const raw = await client.get(cacheKey);
    if (raw) return JSON.parse(raw);
  } else {
    const hit = sportyMemoryCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.payload;
  }

  const payload = sport === 'football'
    ? await getFootballMarket(kind, { hours, maxPages })
    : await getSportMarket(sport, kind, { hours, maxPages });

  if (client) {
    await client.set(cacheKey, JSON.stringify(payload), { EX: ttlSeconds });
  } else {
    sportyMemoryCache.set(cacheKey, {
      expiresAt: Date.now() + ttlSeconds * 1000,
      payload,
    });
  }
  return payload;
}

async function allowBookingRequest(req) {
  const maxPerMinute = Math.max(1, parseInt(process.env.SPORTYBET_BOOKINGS_PER_MINUTE || '5', 10));
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const bucket = Math.floor(Date.now() / 60000);
  const key = `sportybet:bookrate:${ip}:${bucket}`;
  const client = await getRedis();

  if (client) {
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, 70);
    return count <= maxPerMinute;
  }

  const old = bookingMemoryRate.get(key) || 0;
  const next = old + 1;
  bookingMemoryRate.set(key, next);
  if (bookingMemoryRate.size > 1000) {
    for (const k of bookingMemoryRate.keys()) {
      const parts = k.split(':');
      const b = Number(parts[parts.length - 1]);
      if (b < bucket - 1) bookingMemoryRate.delete(k);
    }
  }
  return next <= maxPerMinute;
}

async function loadPredictions() {
  const client = await getRedis();
  if (client) {
    const raw = await client.get('predictions:latest');
    if (raw) return JSON.parse(raw);
    return { generatedAt: null, matches: [] };
  }
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return { generatedAt: null, matches: [] };
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/predictions', async (req, res) => {
  try {
    const payload = await loadPredictions();
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load predictions' });
  }
});



app.get('/api/corners/test-live', async (req, res) => {
  try{
    if(!(process.env.API_FOOTBALL_KEY||process.env.API_FOOTBALL_API_KEY)){
      return res.status(503).json({apiFootballConfigured:false,called:false,error:'API_FOOTBALL_KEY is not configured'});
    }

    const [c,h]=await Promise.all([
      loadSportyBetMarket('corners'),
      loadSportyBetMarket('first_half_team_corners')
    ]);

    const source=[...(c?.rows||[]),...(h?.rows||[])];
    const seen=new Set();
    const fixtures=source.filter(x=>{
      const k=String(x.eventId||'') || `${x.home}|${x.away}|${x.kickoffUtc}`;
      if(!k||seen.has(k)) return false;
      seen.add(k);
      return !!(x.home&&x.away&&x.kickoffUtc);
    }).slice(0,1);

    if(!fixtures.length){
      return res.status(422).json({
        apiFootballConfigured:true,
        called:false,
        sportyCornerRows:(c?.rows||[]).length,
        sportyFirstHalfCornerRows:(h?.rows||[]).length,
        error:'No usable SportyBet corner fixture contained home, away and kickoffUtc'
      });
    }

    const f=fixtures[0];
    const rows=await enrichSportyFixtures(fixtures,{
      daysAhead:3,
      maxFixtures:1,
      cornerEventIds:new Set([String(f.eventId||'')])
    });
    const r=rows[0]||null;

    res.json({
      apiFootballConfigured:true,
      called:true,
      sportyFixture:{eventId:f.eventId,home:f.home,away:f.away,kickoffUtc:f.kickoffUtc},
      apiFootballMatched:!!r,
      apiFootballFixtureId:r?.apiFootballFixtureId||null,
      matchConfidence:r?.apiFootballMatchConfidence||null,
      cornerModel:r?.corners||null,
      success:!!r?.corners,
      message:r?.corners
        ? 'Live API-Football corner model built successfully.'
        : 'API-Football was called, but no corner model was produced. Render logs now show the exact failed stage.'
    });
  }catch(err){
    res.status(500).json({
      apiFootballConfigured:!!(process.env.API_FOOTBALL_KEY||process.env.API_FOOTBALL_API_KEY),
      called:true,
      error:'Live corner test failed',
      detail:String(err.message||err).slice(0,800)
    });
  }
});

app.get('/api/corners/diagnostics', async (req, res) => {
  try{
    const [pred,c,h]=await Promise.all([
      loadPredictions(),
      loadSportyBetMarket('corners'),
      loadSportyBetMarket('first_half_team_corners')
    ]);
    const matches=Array.isArray(pred?.matches)?pred.matches:[];
    const modeled=matches.filter(x=>Number(x?.corners?.totalLambda||0)>0);
    res.json({
      apiFootballConfigured:!!(process.env.API_FOOTBALL_KEY||process.env.API_FOOTBALL_API_KEY),
      predictionMatches:matches.length,
      matchesWithCornerModel:modeled.length,
      sportyCornerRows:Array.isArray(c?.rows)?c.rows.length:0,
      sportyFirstHalfCornerRows:Array.isArray(h?.rows)?h.rows.length:0,
      sampleCornerModels:modeled.slice(0,5).map(x=>({
        eventId:x.eventId||x.sportyEventId||null,
        home:x.home,away:x.away,
        totalLambda:x.corners?.totalLambda,
        firstHalfHomeLambda:x.corners?.firstHalfHomeLambda,
        firstHalfAwayLambda:x.corners?.firstHalfAwayLambda
      }))
    });
  }catch(err){
    res.status(500).json({error:'Corner diagnostics failed',detail:String(err.message||err).slice(0,500)});
  }
});

app.get('/api/api-football/diagnostics', async (req, res) => {
  const configured=!!(process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL_API_KEY);
  if(!configured) return res.status(503).json({configured:false,called:false,error:'API_FOOTBALL_KEY is not configured on this Render service'});
  try{
    const date=new Date().toISOString().slice(0,10);
    const payload=await apiFetch('/fixtures',{date});
    res.json({configured:true,called:true,endpoint:'/fixtures',date,results:Number(payload?.results||0),errors:payload?.errors||[],message:'API-Football call succeeded. This request should appear in your API-Football dashboard.'});
  }catch(err){
    res.status(502).json({configured:true,called:true,error:'API-Football call failed',detail:String(err.message||err).slice(0,500)});
  }
});


// Live-ish SportyBet price layer. The Parse API key never reaches the browser.
// Supported football values: 1x2, gg, dc, dnb, ou15, ou45, ah, oneup. O/U 2.5 is intentionally not used by the Auto Builder.
app.get('/api/sportybet/odds', async (req, res) => {
  try {
    const kind = String(req.query.market || '1x2').toLowerCase();
    if (!['1x2', 'gg', 'dc', 'dnb', 'ou15', 'ou45', 'ah', 'oneup', 'corners', 'first_half_team_corners'].includes(kind)) {
      return res.status(400).json({ error: 'market must be one of: 1x2, gg, dc, dnb, ou15, ou45, ah, oneup, corners, first_half_team_corners' });
    }
    const payload = await loadSportyBetMarket(kind);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(payload);
  } catch (err) {
    console.error('SportyBet odds error:', err.message);
    const status = err.code === 'PARSE_API_KEY_MISSING' ? 503 : 502;
    res.status(status).json({
      error: err.code === 'PARSE_API_KEY_MISSING'
        ? 'SportyBet integration is not configured yet'
        : 'Failed to load SportyBet odds',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});



// Basketball and ice hockey odds. Parse currently exposes pre-match data for these
// sports; this route is generic so more supported sports can be added later.
app.get('/api/sportybet/sport/:sport', async (req, res) => {
  try {
    const sport = String(req.params.sport || '').toLowerCase();
    const cfg = SPORT_CONFIG[sport];
    if (!cfg) {
      return res.status(400).json({ error: `sport must be one of: ${Object.keys(SPORT_CONFIG).join(', ')}` });
    }
    const kind = String(req.query.market || cfg.defaultMarket).toLowerCase();
    if (!cfg.markets[kind]) {
      return res.status(400).json({ error: `market must be one of: ${Object.keys(cfg.markets).join(', ')}` });
    }
    const payload = await loadSportyBetMarket(kind, sport);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(payload);
  } catch (err) {
    console.error('SportyBet sport odds error:', err.message);
    const status = err.code === 'PARSE_API_KEY_MISSING' ? 503 : 502;
    res.status(status).json({
      error: err.code === 'PARSE_API_KEY_MISSING'
        ? 'SportyBet integration is not configured yet'
        : 'Failed to load SportyBet sport odds',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

// Automatic slip builder. It can scan one sport only or all supported sports.
// Football uses Poisson + H2H probability; basketball/hockey use no-vig market probability.
function normalizeSportScope(value) {
  const v = String(value || 'all').toLowerCase().replace(/\s+/g, '');
  if (v === 'icehockey' || v === 'ice-hockey') return 'hockey';
  return ['all', 'football', 'basketball', 'hockey'].includes(v) ? v : 'all';
}


function cornerBetRequested(betTypes) {
  return Array.isArray(betTypes) && betTypes.some(x => {
    const t=String(x || '');
    return ['corners_over','corners_under','first_half_home_team_corners','first_half_away_team_corners'].includes(t)
      || t.startsWith('first_half_home_corners_') || t.startsWith('first_half_away_corners_');
  });
}

function fixtureKey(r) {
  const n=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/\b(fc|cf|afc|sc|ssc|club|football|futbol|calcio)\b/g,'').replace(/[^a-z0-9]+/g,'');
  return `${n(r?.home)}|${n(r?.away)}|${String(r?.kickoffUtc||'').slice(0,10)}`;
}

async function addOnDemandCornerModels(predictions, f1x2, fcorners, f1hteamcorners, hours) {
  if (!process.env.API_FOOTBALL_KEY && !process.env.API_FOOTBALL_API_KEY) {
    console.warn('[API-Football] corner request skipped: API_FOOTBALL_KEY is not configured');
    return predictions;
  }

  const matches=Array.isArray(predictions?.matches)?predictions.matches:[];
  // Match API-Football from the ACTUAL SportyBet corner feeds.
  // Do not intersect with the separate 1X2 feed first: different SportyBet scraper
  // endpoints can expose different event-id namespaces even for the same fixture.
  let sporty=[...(fcorners?.rows||[]),...(f1hteamcorners?.rows||[])];
  if(!sporty.length) sporty=[...(f1x2?.rows||[])];

  const seen=new Set();
  sporty=sporty.filter(x=>{
    const eventId=String(x.eventId||'');
    const key=eventId || `${String(x.home||'')}|${String(x.away||'')}|${String(x.kickoffUtc||'')}`;
    if(!key || seen.has(key)) return false;
    seen.add(key);
    return !!(x.home && x.away && x.kickoffUtc);
  }).slice(0,Math.max(1,Math.min(50,parseInt(process.env.API_FOOTBALL_ON_DEMAND_CORNER_FIXTURES||'20',10))));

  if(!sporty.length){
    console.warn('[API-Football] corner request skipped: no usable SportyBet corner fixtures with home/away/kickoff');
    return predictions;
  }

  console.log(`[API-Football] on-demand corner enrichment starting for ${sporty.length} SportyBet fixtures`);
  const apiRows=await enrichSportyFixtures(sporty,{
    daysAhead:Math.max(1,Math.ceil(Number(hours||120)/24)),
    maxFixtures:sporty.length,
    cornerEventIds:new Set(sporty.map(x=>String(x.eventId||'')))
  });

  const byKey=new Map(apiRows.filter(x=>x?.corners).map(x=>[fixtureKey(x),x]));
  let attached=0;
  for(const old of matches){
    if(Number(old?.corners?.totalLambda||0)>0) continue;
    const hit=byKey.get(fixtureKey(old));
    if(hit?.corners){old.corners=hit.corners;old.apiFootballFixtureId=hit.apiFootballFixtureId;attached++;}
  }
  const existing=new Set(matches.map(fixtureKey));
  let added=0;
  for(const r of apiRows){
    const k=fixtureKey(r);
    if(!existing.has(k)){existing.add(k);matches.push(r);added++;}
  }
  console.log(`[API-Football] on-demand corner enrichment complete: matched=${apiRows.length}, attached=${attached}, added=${added}`);
  return {...predictions,matches};
}

async function loadAutoCandidates({ sportScope = 'all', minProbability = 55, minEdge = 0, leagues = null, betTypes = null, marketHours = null, marketMaxPages = null } = {}) {
  const scope = normalizeSportScope(sportScope);
  const wantsFootball = scope === 'all' || scope === 'football';
  const wantsBasketball = scope === 'all' || scope === 'basketball';
  const wantsHockey = scope === 'all' || scope === 'hockey';

  let [predictions, f1x2, fgg, fdc, fdnb, fou15, fou45, fah, fcorners, f1hteamcorners, foneup, basketballWinner, basketballTotals, hockeyWinner, hockeyTotals] = await Promise.all([
    wantsFootball ? loadPredictions() : Promise.resolve({ matches: [] }),
    wantsFootball ? loadSportyBetMarket('1x2', 'football', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('gg', 'football', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('dc', 'football', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('dnb', 'football', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('ou15', 'football', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('ou45', 'football', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('ah', 'football', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('corners', 'football', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('first_half_team_corners', 'football', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('oneup', 'football', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsBasketball ? loadSportyBetMarket('winner', 'basketball', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsBasketball ? loadSportyBetMarket('totals', 'basketball', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsHockey ? loadSportyBetMarket('winner', 'hockey', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
    wantsHockey ? loadSportyBetMarket('totals', 'hockey', { hours: marketHours || undefined, maxPages: marketMaxPages || undefined }) : Promise.resolve({ rows: [] }),
  ]);

  if (wantsFootball && cornerBetRequested(betTypes)) {
    try {
      predictions = await addOnDemandCornerModels(predictions, f1x2, fcorners, f1hteamcorners, marketHours);
    } catch (err) {
      console.error('[API-Football] on-demand corner enrichment failed:', err.message);
    }
  }

  return buildCandidates({
    predictions,
    footballMarkets: { '1x2': f1x2, gg: fgg, dc: fdc, dnb: fdnb, ou15: fou15, ou45: fou45, ah: fah, corners: fcorners, first_half_team_corners: f1hteamcorners, oneup: foneup },
    basketballWinner,
    basketballTotals,
    hockeyWinner,
    hockeyTotals,
    minProbability,
    minEdge,
    leagues,
    sportScope: scope,
    betTypes,
  });
}


function analyzerNormText(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function analyzerNormTeam(v) {
  return analyzerNormText(v).replace(/\b(fc|cf|afc|sc|ssc|club|football|futbol|calcio)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function analyzerTeamMatch(a, b) {
  const x = analyzerNormTeam(a), y = analyzerNormTeam(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x)));
}

function extractBookingOutcomes(booking) {
  if (!booking || typeof booking !== 'object') return [];
  for (const key of ['outcomes', 'selections', 'bets', 'items']) {
    if (Array.isArray(booking[key])) return booking[key];
  }
  if (booking.data && typeof booking.data === 'object') return extractBookingOutcomes(booking.data);
  return [];
}

function normalizeBookingLeg(row) {
  const home = row.homeTeamName ?? row.home_team ?? row.homeTeam ?? row.home ?? '';
  const away = row.awayTeamName ?? row.away_team ?? row.awayTeam ?? row.away ?? '';
  return {
    sport: String(row.sport ?? row.sport_name ?? ''),
    eventId: String(row.eventId ?? row.event_id ?? row.matchId ?? row.match_id ?? ''),
    home: String(home),
    away: String(away),
    tournament: String(row.tournament ?? row.tournament_name ?? row.league ?? ''),
    marketId: String(row.marketId ?? row.market_id ?? ''),
    marketDesc: String(row.marketDesc ?? row.market_name ?? row.market ?? row.bet_market ?? ''),
    outcomeId: String(row.outcomeId ?? row.outcome_id ?? ''),
    outcomeDesc: String(row.selectedOutcome ?? row.selected_outcome ?? row.outcomeDesc ?? row.outcome_name ?? row.outcome ?? row.pick ?? ''),
    odds: Number(row.odds ?? row.price ?? row.selection_odds) || null,
    specifier: row.specifier ?? row.market_specifier ?? null,
  };
}

function analyzerCandidateScore(leg, c) {
  let score = 0;
  if (leg.eventId && c.eventId && leg.eventId === String(c.eventId)) score += 60;
  if (leg.marketId && c.marketId && leg.marketId === String(c.marketId)) score += 18;
  if (leg.outcomeId && c.outcomeId && leg.outcomeId === String(c.outcomeId)) score += 18;
  if (leg.specifier && c.specifier && analyzerNormText(leg.specifier) === analyzerNormText(c.specifier)) score += 10;
  if (analyzerTeamMatch(leg.home, c.home) && analyzerTeamMatch(leg.away, c.away)) score += 28;
  if (analyzerNormText(leg.marketDesc) && analyzerNormText(c.marketDesc).includes(analyzerNormText(leg.marketDesc))) score += 8;
  const lo = analyzerNormText(leg.outcomeDesc), co = analyzerNormText(c.outcomeDesc);
  if (lo && co && (lo === co || lo.includes(co) || co.includes(lo))) score += 14;
  const legOdds = Number(leg.odds), candOdds = Number(c.odds);
  if (Number.isFinite(legOdds) && Number.isFinite(candOdds)) {
    const diff = Math.abs(legOdds - candOdds);
    if (diff <= 0.005) score += 24;
    else if (diff <= 0.02) score += 18;
    else if (diff <= 0.05) score += 10;
  }
  return score;
}

function isGenericAnalyzerSelection(v) {
  const n = analyzerNormText(v);
  return !n || n === 'selection' || n === 'pick' || n === 'outcome';
}

function isAnalyzerOverUnderMarket(v) {
  const n = analyzerNormText(v);
  return n.includes('over under') || n === 'ou' || n.includes('total goals');
}

// Some get_booking payloads identify the event/market correctly but return only
// the generic word "Selection" for the chosen O/U outcome. Resolve those rows
// against SportyBet's actual Over 1.5 market before the probability-model match.
function resolveGenericOver15Leg(leg, over15Rows) {
  if (!isAnalyzerOverUnderMarket(leg.marketDesc) || !isGenericAnalyzerSelection(leg.outcomeDesc)) {
    return { ...leg, analyzerResolved: false };
  }

  const rows = Array.isArray(over15Rows) ? over15Rows : [];
  let pool = [];
  if (leg.eventId) pool = rows.filter(r => String(r.eventId || '') === String(leg.eventId));
  if (!pool.length) {
    pool = rows.filter(r => analyzerTeamMatch(leg.home, r.home) && analyzerTeamMatch(leg.away, r.away));
  }
  pool = pool.filter(r => {
    const out = analyzerNormText(r.outcomeDesc);
    const spec = analyzerNormText(r.specifier);
    return out.includes('over') && (out.includes('1 5') || spec.includes('total 1 5'));
  });
  if (!pool.length) return { ...leg, analyzerResolved: false };

  const targetOdds = Number(leg.odds);
  pool.sort((a, b) => {
    if (!Number.isFinite(targetOdds)) return 0;
    return Math.abs(Number(a.odds) - targetOdds) - Math.abs(Number(b.odds) - targetOdds);
  });
  const hit = pool[0];
  return {
    ...leg,
    eventId: String(hit.eventId || leg.eventId || ''),
    marketId: String(hit.marketId || leg.marketId || ''),
    outcomeId: String(hit.outcomeId || leg.outcomeId || ''),
    specifier: hit.specifier || 'total=1.5',
    marketDesc: hit.marketDesc || leg.marketDesc || 'Over/Under',
    outcomeDesc: 'Over 1.5',
    // Keep the booked ticket price on screen; current market identifiers are used for matching/re-booking.
    odds: Number(leg.odds) || Number(hit.odds) || null,
    analyzerResolved: true,
    analyzerResolution: 'Resolved generic SportyBet O/U selection as Over 1.5 from the event market',
  };
}

function bookingMetaNumber(booking, keys) {
  for (const k of keys) {
    const n = Number(booking?.[k]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

app.post('/api/sportybet/analyze-code', express.json(), async (req, res) => {
  try {
    const bookingCode = String(req.body?.bookingCode || '').trim().toUpperCase();
    const minProbability = Math.min(95, Math.max(0, Number(req.body?.minProbability) || 55));
    const horizonDays = [7, 14, 21].includes(Number(req.body?.horizonDays)) ? Number(req.body.horizonDays) : Math.max(7, Math.min(21, parseInt(process.env.ANALYZER_DAYS || '14', 10)));
    const analyzerHours = horizonDays * 24;
    const analyzerMaxPages = Math.max(5, Math.min(20, parseInt(process.env.ANALYZER_MAX_PAGES || '12', 10)));
    if (!bookingCode) return res.status(400).json({ error: 'Enter a SportyBet booking code' });

    const booking = await getBooking(bookingCode);
    const decodedRows = extractBookingOutcomes(booking).map(normalizeBookingLeg).filter(x => x.home || x.away || x.eventId);
    if (!decodedRows.length) return res.status(404).json({ error: 'The booking code was found, but no selections could be read from it' });

    // Warm/load the actual football Over 1.5 market first. This lets us repair get_booking
    // rows that say only "Over/Under · Selection" before model scoring. loadAutoCandidates
    // then reuses the same cache entry, so this normally does not add a second O1.5 API call.
    const analyzerOver15 = await loadSportyBetMarket('ou15', 'football', { hours: analyzerHours, maxPages: analyzerMaxPages });
    let sourceRows = decodedRows.map(leg => resolveGenericOver15Leg(leg, analyzerOver15?.rows));

    // Secondary repair for a known get_booking quirk: some legs on the same ticket expose
    // "Over 1.5" while others expose only "Selection". If every explicit O/U pick on this
    // booking is Over 1.5 and there are no conflicting O/U outcomes, classify the remaining
    // generic O/U legs as Over 1.5 for model matching. Re-booking identifiers still come only
    // from a real matched SportyBet candidate below, never from this inference alone.
    const explicitOu = decodedRows
      .filter(x => isAnalyzerOverUnderMarket(x.marketDesc) && !isGenericAnalyzerSelection(x.outcomeDesc))
      .map(x => analyzerNormText(x.outcomeDesc));
    const consistentOver15 = explicitOu.length > 0 && explicitOu.every(x => x.includes('over') && x.includes('1 5'));
    if (consistentOver15) {
      sourceRows = sourceRows.map(leg => {
        if (!isAnalyzerOverUnderMarket(leg.marketDesc) || !isGenericAnalyzerSelection(leg.outcomeDesc) || leg.analyzerResolved) return leg;
        return {
          ...leg,
          marketId: leg.marketId || '18',
          specifier: leg.specifier || 'total=1.5',
          outcomeDesc: 'Over 1.5',
          analyzerResolved: true,
          analyzerResolution: 'Resolved as Over 1.5 from the consistent Over 1.5 pattern in this booking code',
        };
      });
    }

    // Build the complete supported candidate universe with filtering disabled. The Analyzer
    // then applies the user's chosen probability threshold to the exact imported selections.
    const candidates = await loadAutoCandidates({ sportScope: 'all', minProbability: 0, minEdge: -25, leagues: null, betTypes: null, marketHours: analyzerHours, marketMaxPages: analyzerMaxPages });
    const analyzed = sourceRows.map((leg, index) => {
      let best = null, bestScore = -1;
      // Exact SportyBet event ID is the strongest signal. Only fall back to team-name
      // matching when the imported booking does not provide a usable event ID.
      const exactEventCandidates = leg.eventId ? candidates.filter(c => String(c.eventId || '') === leg.eventId) : [];
      const pool = exactEventCandidates.length ? exactEventCandidates : candidates;
      for (const c of pool) {
        const sc = analyzerCandidateScore(leg, c);
        if (sc > bestScore) { bestScore = sc; best = c; }
      }
      const supported = !!best && bestScore >= 60;
      if (!supported) {
        const reason = leg.analyzerResolved
          ? 'Over 1.5 resolved correctly, but no current football probability-model prediction matched this fixture/competition'
          : 'Could not resolve this imported selection to a market supported by the current probability model';
        return { index, ...leg, supported: false, qualified: false, reason };
      }
      const probability = Number(best.probability) || 0;
      const qualified = probability >= minProbability;
      return {
        index,
        ...leg,
        // Use current SportyBet identifiers/odds from the matched market candidate for re-booking.
        eventId: String(best.eventId), marketId: String(best.marketId), outcomeId: String(best.outcomeId), specifier: best.specifier || null,
        sport: best.sport || leg.sport, home: best.home || leg.home, away: best.away || leg.away, tournament: best.tournament || leg.tournament,
        marketDesc: best.marketDesc || leg.marketDesc, outcomeDesc: best.outcomeDesc || leg.outcomeDesc, odds: Number(best.odds) || leg.odds,
        supported: true, qualified,
        probability,
        probabilitySource: best.probabilitySource || '',
        impliedProbability: Number(best.impliedProbability) || null,
        edge: Number(best.edge) || 0,
        expectedValuePct: Number(best.expectedValuePct) || 0,
        qualityScore: Number(best.qualityScore) || null,
        fairOdds: Number(best.fairOdds) || null,
        settlementNote: best.settlementNote || '',
        fullWinProbability: Number(best.fullWinProbability) || null,
        nonLossProbability: Number(best.nonLossProbability) || null,
        reason: qualified ? `Meets ${minProbability}% minimum` : `Below ${minProbability}% minimum`,
      };
    });

    const qualifiedSelections = analyzed.filter(x => x.supported && x.qualified);
    const originalOdds = bookingMetaNumber(booking, ['total_odds','totalOdds','combined_odds','combinedOdds']) || sourceRows.reduce((p,x)=>p*(Number(x.odds)||1),1);
    const filteredOdds = qualifiedSelections.reduce((p,x)=>p*(Number(x.odds)||1),1);
    res.json({
      bookingCode,
      minProbability,
      horizonDays,
      analyzerHours,
      originalSelectionCount: sourceRows.length,
      supportedCount: analyzed.filter(x=>x.supported).length,
      qualifiedCount: qualifiedSelections.length,
      originalCombinedOdds: Math.round(originalOdds*100)/100,
      filteredCombinedOdds: Math.round(filteredOdds*100)/100,
      analyzed,
      qualifiedSelections,
      generatedAt: new Date().toISOString(),
      note: `Analyzer searched up to ${horizonDays} days ahead. Only markets supported by the current Matchday probability engine are scored. Unsupported selections are never assigned a guessed probability.`,
    });
  } catch (err) {
    console.error('SportyBet analyzer error:', err.message);
    const status = err.code === 'INVALID_BOOKING_CODE' ? 400 : err.code === 'PARSE_API_KEY_MISSING' ? 503 : 502;
    res.status(status).json({
      error: err.code === 'PARSE_API_KEY_MISSING' ? 'SportyBet integration is not configured yet' : 'Could not analyze this booking code',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});


async function autoCornerDiagnostics(betTypes) {
  const wantsCorners=Array.isArray(betTypes) && betTypes.some(x=>String(x).includes('corner'));
  if(!wantsCorners) return null;
  try{
    const [pred, c, h] = await Promise.all([
      loadPredictions(),
      loadSportyBetMarket('corners'),
      loadSportyBetMarket('first_half_team_corners')
    ]);
    const matches=Array.isArray(pred?.matches)?pred.matches:[];
    return {
      predictionMatches:matches.length,
      matchesWithCornerModel:matches.filter(x=>Number(x?.corners?.totalLambda||0)>0).length,
      sportyCornerRows:Array.isArray(c?.rows)?c.rows.length:0,
      sportyFirstHalfCornerRows:Array.isArray(h?.rows)?h.rows.length:0,
      apiFootballConfigured:!!(process.env.API_FOOTBALL_KEY||process.env.API_FOOTBALL_API_KEY),
    };
  }catch(e){
    return {diagnosticError:String(e.message||e).slice(0,300)};
  }
}

app.post('/api/sportybet/auto-pick', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const targetOdds = Math.min(2000, Math.max(1.05, Number(body.targetOdds) || 5));
    // Website Auto Builder probability is user-adjustable.
    const minProbability = Math.min(95, Math.max(0, Number(body.minProbability) || 55));
    const maxSelections = Math.min(100, Math.max(1, parseInt(body.maxSelections || '8', 10)));
    const minEdge = Math.min(50, Math.max(-25, Number(body.minEdge) || 0));
    const leagues = Array.isArray(body.leagues) ? body.leagues.map(String) : null;
    const sportScope = normalizeSportScope(body.sportScope);
    const betTypes = Array.isArray(body.betTypes) ? body.betTypes.map(String) : null;

    const candidates = await loadAutoCandidates({ sportScope, minProbability, minEdge, leagues, betTypes });
    const result = selectAutoBet(candidates, { targetOdds, maxSelections });
    if (!result.selections.length) {
      const cornerDiagnostics=await autoCornerDiagnostics(betTypes);
      return res.status(404).json({
        error: 'No eligible SportyBet selections matched the requested sport and minimum probability',
        targetOdds,
        minProbability,
        minEdge,
        sportScope,
        requestedBetTypes: betTypes,
        candidateCount: candidates.length,
        cornerDiagnostics,
        hint: cornerDiagnostics
          ? 'Corner diagnostics included. matchesWithCornerModel must be > 0 and SportyBet corner rows must be > 0.'
          : undefined,
      });
    }

    res.json({
      ...result,
      sportScope,
      minProbability,
      minEdge,
      maxSelections,
      betTypes,
      generatedAt: new Date().toISOString(),
      note: 'Value engine: football uses 1X2, 1UP, Corners O/U, GG/NG, Double Chance, Draw No Bet, Over 1.5, Under 4.5 and Asian Handicap +0/+0.25/-0.25. O/U 2.5 is excluded. DNB/AH use settlement-aware fair odds and EV; basketball/hockey remain no-vig market estimates.',
    });
  } catch (err) {
    console.error('SportyBet auto-pick error:', err.message);
    const status = err.code === 'PARSE_API_KEY_MISSING' ? 503 : 502;
    res.status(status).json({
      error: err.code === 'PARSE_API_KEY_MISSING'
        ? 'SportyBet integration is not configured yet'
        : 'Failed to build automatic SportyBet slip',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

function parseTargetList(value) {
  const defaults = [1000, 750, 250, 100, 50, 20];
  const list = String(value || defaults.join(','))
    .split(',')
    .map(x => Number(x.trim()))
    .filter(x => Number.isFinite(x) && x >= 1.05 && x <= 2000);
  return list.length ? [...new Set(list)] : defaults;
}

function telegramSlipText(target, result, booking, sportScope) {
  const status = result.reachedTarget ? 'TARGET REACHED' : 'CLOSEST AVAILABLE';
  const lines = [
    `🎯 MATCHDAY AUTO CODE — ${target} ODDS`,
    `${status} | ${sportScope.toUpperCase()}`,
    `Actual odds: ${Number(result.combinedOdds || 1).toFixed(2)}`,
    `Average leg probability: ${Number(result.averageProbability || 0).toFixed(1)}%`,
    `Minimum leg probability: ${Number(result.minimumProbability || 0).toFixed(1)}%`,
    `Estimated slip fair-price probability: ${Number(result.estimatedSlipProbability || 0).toFixed(3)}%`,
    `Average probability edge: ${Number(result.averageEdge || 0).toFixed(1)} pts`,
    `Average quality score: ${Number(result.averageQualityScore || 0).toFixed(1)}/100`,
    `Estimated slip EV: ${Number(result.estimatedSlipEVPct || 0).toFixed(1)}%`,
    `Selections: ${result.selections.length}`,
    `SportyBet code: ${booking?.shareCode || 'NO CODE RETURNED'}`,
    '',
  ];
  result.selections.forEach((x, i) => {
    lines.push(`${i + 1}. [${x.sport}] ${x.home} vs ${x.away}`);
    lines.push(`   ${x.outcomeDesc || x.marketDesc} @ ${Number(x.odds).toFixed(2)} | model/fair ${Number(x.probability).toFixed(1)}% | implied ${Number(x.impliedProbability || 0).toFixed(1)}% | edge ${Number(x.edge || 0).toFixed(1)} | Q ${Number(x.qualityScore || 0).toFixed(1)}`);
    if (x.settlementNote && x.settlementNote !== 'Win/lose market') lines.push(`   Settlement: ${x.settlementNote} | full-win ${Number(x.fullWinProbability || 0).toFixed(1)}% | non-loss ${Number(x.nonLossProbability || 0).toFixed(1)}% | fair odds ${Number(x.fairOdds || 0).toFixed(2)}`);
  });
  if (booking?.shareURL) lines.push('', `SportyBet link: ${booking.shareURL}`);
  if (Array.isArray(booking?.unavailableOutcomes) && booking.unavailableOutcomes.length) {
    lines.push('', `⚠️ ${booking.unavailableOutcomes.length} outcome(s) were unavailable when the code was created.`);
  }
  return lines.join('\n');
}

async function runTelegramDailyPicks() {
  const targets = parseTargetList(process.env.TELEGRAM_TARGET_ODDS);
  const sportScope = normalizeSportScope(process.env.TELEGRAM_SPORT_SCOPE || 'all');
  const minProbability = Math.min(95, Math.max(70, Number(process.env.TELEGRAM_MIN_PROBABILITY || 70)));
  const maxSelections = Math.min(100, Math.max(1, parseInt(process.env.TELEGRAM_MAX_SELECTIONS || '30', 10)));
  const minEdge = Math.min(50, Math.max(-25, Number(process.env.TELEGRAM_MIN_EDGE || 0)));
  const leagues = process.env.TELEGRAM_FOOTBALL_LEAGUES
    ? process.env.TELEGRAM_FOOTBALL_LEAGUES.split(',').map(x => x.trim()).filter(Boolean)
    : null;
  // Diversify the different target-odds slips sent in the same Telegram run.
  // A game + bet type below this probability may appear in only one sent slip.
  // Picks at/above the threshold are strong enough to be reused across target slips.
  const repeatThreshold = Math.min(100, Math.max(0, Number(process.env.TELEGRAM_REPEAT_MIN_PROBABILITY || 80)));
  const usedLowConfidenceKeys = new Set();
  const repeatKey = c => `${String(c.eventId)}|${String(c.betType || c.marketKind || c.marketId)}`;

  const candidates = await loadAutoCandidates({ sportScope, minProbability, minEdge, leagues });
  if (!candidates.length) throw new Error('No eligible candidates are available for the Telegram picks job');

  await sendTelegramMessage([
    '🤖 MATCHDAY ODDS DESK — AUTO PICKS',
    `Scope: ${sportScope.toUpperCase()}`,
    `Targets: ${targets.join(', ')}`,
    `Minimum probability: ${minProbability}%`,
    `Minimum football edge: ${minEdge} pts`,
    `Eligible candidates scanned: ${candidates.length}`,
    `Cross-slip repeat rule: same game + bet type repeats only at ${repeatThreshold}%+`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'Model probabilities are estimates, not guarantees.',
  ].join('\n'));

  const output = [];
  for (const target of targets) {
    const diversifiedCandidates = candidates.filter(c => Number(c.probability || 0) >= repeatThreshold || !usedLowConfidenceKeys.has(repeatKey(c)));
    const result = selectAutoBet(diversifiedCandidates, {
      targetOdds: target,
      maxSelections,
      trials: Number(process.env.TELEGRAM_PICK_TRIALS || 2200),
    });

    if (!result.selections.length) {
      const failure = { targetOdds: target, error: 'No eligible combination found' };
      output.push(failure);
      await sendTelegramMessage(`⚠️ Could not build the ${target} odds slip with the current filters.`);
      continue;
    }

    try {
      const booking = await bookBet(result.selections.map(x => ({
        eventId: x.eventId,
        marketId: x.marketId,
        outcomeId: x.outcomeId,
        ...(x.specifier ? { specifier: x.specifier } : {}),
      })));
      await sendTelegramMessage(telegramSlipText(target, result, booking, sportScope));
      for (const x of result.selections) {
        if (Number(x.probability || 0) < repeatThreshold) usedLowConfidenceKeys.add(repeatKey(x));
      }
      // Persist every automatically generated code that was actually sent to Telegram.
      // Redis is strongly recommended so tracking survives Render restarts/deploys.
      await trackTelegramSlip(await getRedis(), {
        shareCode: booking?.shareCode,
        shareURL: booking?.shareURL,
        targetOdds: target,
        combinedOdds: result.combinedOdds,
        sportScope,
        selections: result.selections,
      });
      output.push({
        targetOdds: target,
        combinedOdds: result.combinedOdds,
        averageProbability: result.averageProbability,
        estimatedSlipProbability: result.estimatedSlipProbability,
        averageEdge: result.averageEdge,
        averageQualityScore: result.averageQualityScore,
        estimatedSlipEVPct: result.estimatedSlipEVPct,
        selections: result.selections.length,
        shareCode: booking?.shareCode || null,
        unavailable: Array.isArray(booking?.unavailableOutcomes) ? booking.unavailableOutcomes.length : 0,
      });
    } catch (err) {
      output.push({ targetOdds: target, combinedOdds: result.combinedOdds, error: err.message });
      await sendTelegramMessage(`⚠️ ${target} odds slip was built at ${result.combinedOdds}, but SportyBet code generation failed: ${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }

  return { sportScope, minProbability, minEdge, maxSelections, repeatThreshold, candidateCount: candidates.length, results: output };
}


function telegramWinningSlipText(slip) {
  const successLegs = Array.isArray(slip.selections) ? slip.selections.length : 0;
  return [
    '🏆 BET CODE SUCCESSFUL',
    '',
    `SportyBet Code: ${slip.shareCode}`,
    ...(slip.targetOdds ? [`Target Odds: ${slip.targetOdds}`] : []),
    ...(slip.combinedOdds ? [`Actual Odds: ${Number(slip.combinedOdds).toFixed(2)}`] : []),
    `✅ ${successLegs} / ${successLegs} selections successful/void-safe`,
    '❌ 0 confirmed losses',
    '',
    `Generated: ${slip.createdAt}`,
    `Confirmed: ${new Date().toISOString()}`,
    '',
    '🎯 FULL SLIP WON',
    ...(slip.shareURL ? ['', `SportyBet link: ${slip.shareURL}`] : []),
  ].join('\n');
}

async function runTelegramSettlementCheck() {
  const client = await getRedis();
  if (!client && process.env.NODE_ENV === 'production') {
    console.warn('Settlement tracker is using memory only. Configure REDIS_URL for reliable persistence across Render restarts.');
  }
  const slips = await listTrackedSlips(client);
  const pending = slips.filter(x => x.status === 'pending' && !x.successAlertSent);
  const stats = { tracked: slips.length, checked: 0, won: 0, lost: 0, pending: 0, errors: 0, alertsSent: 0 };

  for (const slip of pending) {
    try {
      // Avoid spending a booking-status API credit before the first scheduled event.
      const kickoffTimes = (slip.selections || []).map(x => Date.parse(x.kickoffUtc || '')).filter(Number.isFinite);
      if (kickoffTimes.length && Date.now() < Math.min(...kickoffTimes)) {
        stats.pending++;
        continue;
      }
      const booking = await getBooking(slip.shareCode);
      const evaluation = evaluateBooking(booking);
      stats.checked++;
      const patch = {
        status: evaluation.status,
        lastCheckedAt: new Date().toISOString(),
        lastStatusDetail: evaluation,
      };
      if (evaluation.status === 'won') {
        stats.won++;
        // Mark first, then alert. This favors never sending duplicate success alerts.
        // If Telegram itself fails, the endpoint reports the error and an admin can
        // inspect/reset the record rather than spamming the channel on every retry.
        patch.successAlertSent = true;
        patch.successAlertSentAt = new Date().toISOString();
        const updated = await updateTrackedSlip(client, slip.shareCode, patch);
        await sendTelegramMessage(telegramWinningSlipText(updated || { ...slip, ...patch }));
        stats.alertsSent++;
      } else {
        await updateTrackedSlip(client, slip.shareCode, patch);
        if (evaluation.status === 'lost') stats.lost++;
        else stats.pending++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`Settlement check ${slip.shareCode}:`, err.message);
      await updateTrackedSlip(client, slip.shareCode, { lastCheckedAt: new Date().toISOString(), lastStatusDetail: { error: err.message } }).catch(()=>{});
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }

  if (String(process.env.TELEGRAM_SETTLEMENT_SUMMARY || 'true').toLowerCase() !== 'false') {
    await sendTelegramMessage([
      '📋 MATCHDAY — DAILY SLIP CHECK',
      `Tracked codes: ${stats.tracked}`,
      `Checked today: ${stats.checked}`,
      `🏆 Newly successful: ${stats.won}`,
      `❌ Newly confirmed lost: ${stats.lost}`,
      `⏳ Still pending/not due: ${stats.pending}`,
      ...(stats.errors ? [`⚠️ Check errors: ${stats.errors}`] : []),
      `Success alerts sent: ${stats.alertsSent}`,
    ].join('\n'));
  }
  return stats;
}

app.post('/api/telegram/check-settlements', express.json(), async (req, res) => {
  try {
    const secret = process.env.TELEGRAM_JOB_SECRET;
    if (!secret || req.headers['x-telegram-job-secret'] !== secret) return res.status(401).json({ error: 'unauthorized' });
    const stats = await runTelegramSettlementCheck();
    res.json({ ok: true, checkedAt: new Date().toISOString(), ...stats });
  } catch (err) {
    console.error('Telegram settlement job error:', err.message);
    res.status(err.code === 'TELEGRAM_CONFIG_MISSING' ? 503 : 502).json({
      error: err.code === 'TELEGRAM_CONFIG_MISSING' ? 'Telegram integration is not configured yet' : 'Telegram settlement job failed',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

app.get('/api/telegram/status', (req, res) => {
  res.json({
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_JOB_SECRET),
    targets: parseTargetList(process.env.TELEGRAM_TARGET_ODDS),
    sportScope: normalizeSportScope(process.env.TELEGRAM_SPORT_SCOPE || 'all'),
    minProbability: Math.min(95, Math.max(70, Number(process.env.TELEGRAM_MIN_PROBABILITY || 70))),
    minEdge: Math.min(50, Math.max(-25, Number(process.env.TELEGRAM_MIN_EDGE || 0))),
    maxSelections: Math.min(100, Math.max(1, parseInt(process.env.TELEGRAM_MAX_SELECTIONS || '30', 10))),
    scheduler: 'GitHub Actions',
  });
});

// Protected endpoint intended for GitHub Actions / Render Cron. It builds all
// configured target slips, creates SportyBet booking codes, and sends them to Telegram.
app.post('/api/telegram/daily-picks', express.json(), async (req, res) => {
  try {
    const secret = process.env.TELEGRAM_JOB_SECRET;
    if (!secret || req.headers['x-telegram-job-secret'] !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const result = await runTelegramDailyPicks();
    res.json({ ok: true, generatedAt: new Date().toISOString(), ...result });
  } catch (err) {
    console.error('Telegram daily picks error:', err.message);
    res.status(err.code === 'TELEGRAM_CONFIG_MISSING' ? 503 : 502).json({
      error: err.code === 'TELEGRAM_CONFIG_MISSING' ? 'Telegram integration is not configured yet' : 'Telegram picks job failed',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

app.post('/api/telegram/test', express.json(), async (req, res) => {
  try {
    const secret = process.env.TELEGRAM_JOB_SECRET;
    if (!secret || req.headers['x-telegram-job-secret'] !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    await sendTelegramMessage('✅ Matchday Odds Desk Telegram integration is connected.');
    res.json({ ok: true });
  } catch (err) {
    console.error('Telegram test error:', err.message);
    res.status(502).json({ error: 'Telegram test failed', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
  }
});



// One-click website share. The browser receives a short-lived one-time token only;
// Telegram credentials and the job secret never leave Render.
app.post('/api/telegram/send-slip', express.json(), async (req, res) => {
  try {
    const payload = await consumeTelegramSendToken(req.body && req.body.token);
    if (!payload) return res.status(400).json({ error: 'Send token is invalid, expired, or already used. Generate the SportyBet code again.' });
    if (!payload.shareCode) return res.status(400).json({ error: 'No SportyBet code is attached to this send token' });
    await sendTelegramMessage(telegramManualSlipText(payload));
    res.json({ ok: true });
  } catch (err) {
    console.error('Telegram manual slip error:', err.message);
    res.status(err.code === 'TELEGRAM_CONFIG_MISSING' ? 503 : 502).json({
      error: err.code === 'TELEGRAM_CONFIG_MISSING' ? 'Telegram integration is not configured yet' : 'Failed to send slip to Telegram',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

app.post('/api/sportybet/book', express.json(), async (req, res) => {
  try {
    if (!(await allowBookingRequest(req))) {
      return res.status(429).json({ error: 'Too many booking requests; try again in a minute' });
    }
    const selections = req.body && req.body.selections;
    if (!Array.isArray(selections) || selections.length === 0 || selections.length > 30) {
      return res.status(400).json({ error: 'selections must be an array containing 1-30 selections' });
    }
    const result = await bookBet(selections);
    const slip = sanitizeTelegramSlip(req.body && req.body.telegramContext);
    const telegramSendToken = await createTelegramSendToken({
      shareCode: result?.shareCode || null,
      shareURL: result?.shareURL || null,
      slip,
      createdAt: new Date().toISOString(),
    });
    res.json({ ...result, telegramSendToken });
  } catch (err) {
    console.error('SportyBet booking error:', err.message);
    const status = err.code === 'PARSE_API_KEY_MISSING' ? 503 : 502;
    res.status(status).json({
      error: err.code === 'PARSE_API_KEY_MISSING'
        ? 'SportyBet integration is not configured yet'
        : 'Failed to create SportyBet booking code',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

// Manual/scheduled trigger to run the refresh job (protected by a shared secret).
// Pulling every league while respecting football-data.org's rate limit can take
// a couple of minutes, so this kicks the job off in the background and returns
// immediately rather than holding the HTTP request open the whole time.
app.post('/api/refresh', express.json(), (req, res) => {
  if (!process.env.REFRESH_SECRET || req.headers['x-refresh-secret'] !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { spawn } = require('child_process');
  const child = spawn('node', [path.join(__dirname, 'jobs', 'refresh.js')], {
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; console.log(d.toString().trim()); });
  child.stderr.on('data', (d) => { log += d; console.error(d.toString().trim()); });
  child.on('exit', (code) => {
    console.log(`refresh job exited with code ${code}`);
  });
  child.unref();
  res.json({ ok: true, started: true, message: 'Refresh started in the background; check /api/predictions in a couple of minutes.' });
});

app.listen(PORT, () => console.log(`Matchday site listening on :${PORT}`));
