const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // Render forwards the real client IP.
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'predictions.json');
const { getFootballMarket, getSportMarket, getBooking, bookBet, SPORT_CONFIG } = require('./lib/sportybet');
const { buildCandidates, selectAutoBet, passesRedFlagFilter} = require('./lib/autoPicker');
const { sendTelegramMessage, sendTelegramMessageTo, telegramRequest, sendTelegramAiMessageTo, telegramAiRequest } = require('./lib/telegram');
const { PLANS: TELEGRAM_AI_PLANS, ALL_BET_IDS: TELEGRAM_AI_ALL_BET_IDS, allowedBetIdsForPlan: telegramAiAllowedBetIdsForPlan, getUser: getTelegramAiUser, saveUser: saveTelegramAiUser, getPlan: getTelegramAiPlan, consume: consumeTelegramAiUsage, activatePlan: activateTelegramAiPlan, addExtraTickets: addTelegramAiExtraTickets, hasTicketCredit: telegramAiHasTicketCredit, parseNaturalRequest: parseTelegramAiRequest, planKeyboard: telegramAiPlanKeyboard, ticketLimitKeyboard: telegramAiTicketLimitKeyboard, mainKeyboard: telegramAiMainKeyboard, builderSummary: telegramAiBuilderSummary, builderKeyboard: telegramAiBuilderKeyboard, sportKeyboard: telegramAiSportKeyboard, targetKeyboard: telegramAiTargetKeyboard, probabilityKeyboard: telegramAiProbabilityKeyboard, maxOddKeyboard: telegramAiMaxOddKeyboard, edgeKeyboard: telegramAiEdgeKeyboard, maxGamesKeyboard: telegramAiMaxGamesKeyboard, marketsKeyboard: telegramAiMarketsKeyboard, analyzerSummary: telegramAiAnalyzerSummary, analyzerKeyboard: telegramAiAnalyzerKeyboard, analyzerAnalysisKeyboard: telegramAiAnalyzerAnalysisKeyboard, analyzerProbKeyboard: telegramAiAnalyzerProbKeyboard, analyzerHorizonKeyboard: telegramAiAnalyzerHorizonKeyboard, resultKeyboard: telegramAiResultKeyboard, plansText: telegramAiPlansText } = require('./lib/telegramAiBot');
const { trackTelegramSlip, listTrackedSlips, updateTrackedSlip, evaluateBooking } = require('./lib/slipTracker');
const { apiFetch, enrichSportyFixtures } = require('./lib/apiFootball');
const { addObservedCode, importSportySocialBatch, buildLeaderboard, readStore: readCopyHubStore, scanXRecent, settlePending: settleCopyHubPending, getPunterProfile } = require('./lib/copyHub');

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

function copyHubEnabled() {
  return String(process.env.COPY_HUB_ENABLED || '').toLowerCase() === 'true';
}

function authorizeCopyHub(req) {
  const secret = process.env.COPY_HUB_SECRET || '';
  return !!secret && req.headers['x-copy-hub-secret'] === secret;
}


const sportyMemoryCache = new Map();
const sportyMarketInFlight = new Map();
const bookingMemoryRate = new Map();
const telegramSendMemory = new Map();



function sanitizeTelegramSlip(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 40).map(x => ({
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

function filterUpcomingSportyPayload(payload, { nowMs = Date.now(), kickoffBufferSeconds = 60 } = {}) {
  if (!payload || !Array.isArray(payload.rows)) return payload;
  const cutoff = nowMs + Math.max(0, Number(kickoffBufferSeconds) || 0) * 1000;
  let validKickoff = 0, missingOrInvalidKickoff = 0, pastOrStarted = 0;
  const rows = payload.rows.filter(row => {
    const kickoffMs = Date.parse(row?.kickoffUtc || '');
    // Important: the managed SportyBet market endpoint often omits kickoff time.
    // Missing/invalid kickoff must NOT cause a valid current selection to be discarded.
    // We only remove a row when a valid timestamp explicitly proves it has started/expired.
    if (!Number.isFinite(kickoffMs)) {
      missingOrInvalidKickoff++;
      return true;
    }
    validKickoff++;
    if (kickoffMs <= cutoff) {
      pastOrStarted++;
      return false;
    }
    return true;
  });
  console.log(`[SportyBet filter] raw=${payload.rows.length} validKickoff=${validKickoff} missingKickoffKept=${missingOrInvalidKickoff} pastOrStartedRemoved=${pastOrStarted} returned=${rows.length}`);
  return {
    ...payload,
    rows,
    totalReturned: rows.length,
    staleRowsRemoved: pastOrStarted,
    missingKickoffKept: missingOrInvalidKickoff,
    upcomingFilteredAt: new Date(nowMs).toISOString(),
  };
}

function sportyPayloadAgeSeconds(payload, nowMs = Date.now()) {
  const fetchedMs = Date.parse(payload?.fetchedAt || '');
  return Number.isFinite(fetchedMs) ? Math.max(0, (nowMs - fetchedMs) / 1000) : Infinity;
}

function filterSportyPayloadToHours(payload, hours, nowMs = Date.now()) {
  if (!payload || !Array.isArray(payload.rows)) return payload;
  const upper = nowMs + Math.max(1, Number(hours) || 1) * 3600 * 1000;
  const rows = payload.rows.filter(row => {
    const t = Date.parse(row?.kickoffUtc || '');
    return !Number.isFinite(t) || t <= upper;
  });
  return { ...payload, rows, totalReturned: rows.length };
}

function sportySnapshotKey(sport, kind) {
  const v = String(process.env.SPORTYBET_CACHE_VERSION || '9');
  return `sportybet:snapshot:v${v}:${sport}:${kind}`;
}

async function readSportySnapshot(client, sport, kind, hours, nowMs, kickoffBufferSeconds) {
  const key = sportySnapshotKey(sport, kind);
  let snapshot = null;
  if (client) {
    try { const raw = await client.get(key); if (raw) snapshot = JSON.parse(raw); } catch {}
  } else {
    const hit = sportyMemoryCache.get(key);
    if (hit && hit.expiresAt > nowMs) snapshot = hit.payload;
  }
  if (!snapshot || Number(snapshot.snapshotHours || 0) < Number(hours || 0)) return null;
  const maxAge = Math.max(300, parseInt(process.env.SPORTYBET_DAILY_SNAPSHOT_MAX_AGE_SECONDS || '90000', 10));
  if (sportyPayloadAgeSeconds(snapshot, nowMs) > maxAge) return null;
  let filtered = filterUpcomingSportyPayload(snapshot, { nowMs, kickoffBufferSeconds });
  filtered = filterSportyPayloadToHours(filtered, hours, nowMs);
  return Array.isArray(filtered?.rows) && filtered.rows.length ? filtered : null;
}

async function writeSportySnapshot(client, sport, kind, payload, hours) {
  if (!payload || !Array.isArray(payload.rows) || !payload.rows.length) return;
  const key = sportySnapshotKey(sport, kind);
  const ttl = Math.max(3600, parseInt(process.env.SPORTYBET_DAILY_SNAPSHOT_SECONDS || '93600', 10));
  const snapshot = { ...payload, snapshotHours: Number(hours) || 0, snapshotSavedAt: new Date().toISOString() };
  if (client) await client.set(key, JSON.stringify(snapshot), { EX: ttl }).catch(()=>{});
  else sportyMemoryCache.set(key, { expiresAt: Date.now() + ttl * 1000, payload: snapshot });
}

async function loadSportyBetMarket(kind, sport = 'football', options = {}) {
  const ttlSeconds = Math.max(60, parseInt(process.env.SPORTYBET_CACHE_SECONDS || '43200', 10));
  const normalHours = Math.max(1, parseInt(process.env.SPORTYBET_HOURS || String((parseInt(process.env.DAYS_AHEAD || '4', 10) + 1) * 24), 10));
  const hours = Math.max(1, Math.min(24 * 21, parseInt(options.hours || normalHours, 10)));
  const maxPages = Math.max(1, Math.min(20, parseInt(options.maxPages || process.env.SPORTYBET_MAX_PAGES || '5', 10)));
  const maxCacheAgeSeconds = Number.isFinite(Number(options.maxCacheAgeSeconds))
    ? Math.max(0, Number(options.maxCacheAgeSeconds))
    : null;
  const kickoffBufferSeconds = Math.max(0, Number(options.kickoffBufferSeconds ?? process.env.SPORTYBET_KICKOFF_BUFFER_SECONDS ?? 60) || 0);
  // Keep Analyzer's 14/21-day cache completely separate from the normal Auto Builder cache.
  // Versioned cache key: bumping this invalidates stale/empty market caches after parser changes.
  const cacheVersion = String(process.env.SPORTYBET_CACHE_VERSION || '9');
  const cacheKey = `sportybet:v${cacheVersion}:${sport}:${kind}:h${hours}:p${maxPages}`;
  const client = await getRedis();
  const nowMs = Date.now();

  // Shared daily snapshot is independent of request horizon/page count. A 7/14-day
  // Analyzer request can therefore reuse a 21-day Daily Refresh snapshot instead of
  // purchasing the same SportyBet rows again.
  const snapshot = await readSportySnapshot(client, sport, kind, hours, nowMs, kickoffBufferSeconds);
  if (snapshot) {
    console.log(`[SportyBet snapshot] HIT ${sport}/${kind} requested=${hours}h snapshot=${snapshot.snapshotHours}h rows=${snapshot.rows.length}`);
    return snapshot;
  }

  let cached = null;
  if (client) {
    const raw = await client.get(cacheKey);
    if (raw) cached = JSON.parse(raw);
  } else {
    const hit = sportyMemoryCache.get(cacheKey);
    if (hit && hit.expiresAt > nowMs) cached = hit.payload;
  }

  if (cached && (maxCacheAgeSeconds == null || sportyPayloadAgeSeconds(cached, nowMs) <= maxCacheAgeSeconds)) {
    const filteredCached = filterUpcomingSportyPayload(cached, { nowMs, kickoffBufferSeconds });
    // Never let an empty cache (or a cache whose fixtures have all kicked off)
    // block discovery of newly-added SportyBet fixtures. Refresh immediately.
    if (Array.isArray(filteredCached?.rows) && filteredCached.rows.length > 0) {
      return filteredCached;
    }
    // A recently fetched empty result is a short negative cache. Serve it quickly
    // until SPORTYBET_EMPTY_CACHE_SECONDS expires instead of hammering the upstream API.
    const age = sportyPayloadAgeSeconds(cached, nowMs);
    const emptyTtl = Math.max(15, Math.min(300, parseInt(process.env.SPORTYBET_EMPTY_CACHE_SECONDS || '60', 10)));
    if (age <= emptyTtl) return filteredCached;
    if (client) await client.del(cacheKey).catch(()=>{});
    else sportyMemoryCache.delete(cacheKey);
  }

  // Analyzer replacement can be configured to use only data already saved by the Daily Refresh.
  // When cacheOnly is true, never purchase a fresh Parse.bot market call here.
  if (options.cacheOnly) {
    console.log(`[SportyBet cache-only] MISS ${sport}/${kind} requested=${hours}h`);
    return { rows: [], cacheOnly: true, fetchedAt: null };
  }

  // Collapse concurrent requests for the same sport/market/window into one upstream call.
  // This is important because the Auto Builder and Analyzer can ask for overlapping markets.
  let refreshPromise = sportyMarketInFlight.get(cacheKey);
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const payload = sport === 'football'
        ? await getFootballMarket(kind, { hours, maxPages })
        : await getSportMarket(sport, kind, { hours, maxPages });

      const filteredPayload = filterUpcomingSportyPayload(payload, { nowMs: Date.now(), kickoffBufferSeconds });
      if (Array.isArray(filteredPayload?.rows) && filteredPayload.rows.length > 0) {
        if (client) await client.set(cacheKey, JSON.stringify(payload), { EX: ttlSeconds });
        else sportyMemoryCache.set(cacheKey, { expiresAt: Date.now() + ttlSeconds * 1000, payload });
        await writeSportySnapshot(client, sport, kind, payload, hours);
      } else {
        // Short negative cache: prevents every page click from making another slow Parse call,
        // while still retrying quickly enough to discover newly-added SportyBet fixtures.
        const emptyTtl = Math.max(15, Math.min(300, parseInt(process.env.SPORTYBET_EMPTY_CACHE_SECONDS || '60', 10)));
        const emptyPayload = { ...(payload || {}), rows: [], fetchedAt: new Date().toISOString() };
        if (client) await client.set(cacheKey, JSON.stringify(emptyPayload), { EX: emptyTtl });
        else sportyMemoryCache.set(cacheKey, { expiresAt: Date.now() + emptyTtl * 1000, payload: emptyPayload });
        console.warn(`[SportyBet] ${sport}/${kind}: 0 upcoming outcomes; retry cache ${emptyTtl}s.`);
      }
      return filteredPayload;
    })();
    sportyMarketInFlight.set(cacheKey, refreshPromise);
    refreshPromise.finally(() => sportyMarketInFlight.delete(cacheKey)).catch(()=>{});
  }
  return await refreshPromise;
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


// -----------------------------------------------------------------------------
// Website access-code gate
// -----------------------------------------------------------------------------
// This protects the browser UI without interfering with GitHub/Telegram job APIs.
// Configure WEBSITE_ACCESS_CODE in Render. Do not hard-code the code in public files.
const WEBSITE_ACCESS_COOKIE = 'matchday_access';
const WEBSITE_ACCESS_MAX_AGE_SECONDS = Math.max(
  300,
  parseInt(process.env.WEBSITE_ACCESS_MAX_AGE_SECONDS || String(7 * 24 * 60 * 60), 10) || (7 * 24 * 60 * 60)
);

function websiteAccessCode() {
  return String(process.env.WEBSITE_ACCESS_CODE || '');
}

function websiteAccessToken() {
  const code = websiteAccessCode();
  if (!code) return '';
  const secret = String(process.env.WEBSITE_ACCESS_SESSION_SECRET || code);
  return crypto.createHmac('sha256', secret).update(`matchday-access-v1:${code}`).digest('hex');
}

function parseCookieHeader(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return;
    try { out[key] = decodeURIComponent(value); }
    catch { out[key] = value; }
  });
  return out;
}

function safeEqualString(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function hasWebsiteAccess(req) {
  const expected = websiteAccessToken();
  if (!expected) return false;
  const cookies = parseCookieHeader(req.headers.cookie);
  return safeEqualString(cookies[WEBSITE_ACCESS_COOKIE], expected);
}

function accessPage(message = '') {
  const error = message ? `<div class="error">${String(message).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]))}</div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Matchday Odds Desk — Access</title>
<style>
  *{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b09;color:#f3f7f4;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
  .card{width:min(430px,100%);background:linear-gradient(180deg,#111814,#0c110e);border:1px solid #26352c;border-radius:20px;padding:30px;box-shadow:0 24px 70px rgba(0,0,0,.5)}
  .brand{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#58df84;font-weight:800;margin-bottom:10px}.title{font-size:28px;font-weight:850;margin:0 0 8px}.sub{color:#9eaaa2;line-height:1.55;margin:0 0 24px}
  label{display:block;font-size:13px;font-weight:700;margin-bottom:8px;color:#cbd5ce} input{width:100%;border:1px solid #34463a;background:#070a08;color:#fff;border-radius:12px;padding:14px 15px;font-size:17px;outline:none} input:focus{border-color:#36cf6a;box-shadow:0 0 0 3px rgba(54,207,106,.12)}
  button{width:100%;margin-top:14px;border:0;border-radius:12px;padding:14px 16px;font-size:15px;font-weight:850;background:#27c45b;color:#031006;cursor:pointer} button:hover{filter:brightness(1.06)}
  .error{margin:0 0 16px;padding:11px 13px;border:1px solid #6b2929;background:#2a1111;color:#ffb6b6;border-radius:10px;font-size:13px}.foot{margin-top:18px;text-align:center;font-size:11px;color:#68746c}
</style>
</head>
<body><main class="card"><div class="brand">PLOT207 SPORTS</div><h1 class="title">Access required</h1><p class="sub">Enter the website access code to continue to Matchday Odds Desk.</p>${error}<form method="post" action="/access"><label for="code">Access code</label><input id="code" name="code" type="password" autocomplete="current-password" required autofocus><button type="submit">Unlock Website</button></form><div class="foot">Authorized access only</div></main></body></html>`;
}

app.get('/access', (req, res) => {
  if (hasWebsiteAccess(req)) return res.redirect('/');
  res.set('Cache-Control', 'no-store');
  if (!websiteAccessCode()) return res.status(503).send(accessPage('Website access is not configured yet. Set WEBSITE_ACCESS_CODE in Render.'));
  res.status(200).send(accessPage(''));
});

app.post('/access', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const expected = websiteAccessCode();
  if (!expected) return res.status(503).send(accessPage('Website access is not configured yet. Set WEBSITE_ACCESS_CODE in Render.'));
  const supplied = String(req.body?.code || '');
  if (!safeEqualString(supplied, expected)) return res.status(401).send(accessPage('Incorrect access code.'));

  const cookie = [
    `${WEBSITE_ACCESS_COOKIE}=${encodeURIComponent(websiteAccessToken())}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${WEBSITE_ACCESS_MAX_AGE_SECONDS}`
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${WEBSITE_ACCESS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.redirect('/access');
});

// Protect browser/static website requests. API routes keep their existing own secrets/auth
// so scheduled GitHub workflows and Telegram integrations are not broken by this gate.
app.use((req, res, next) => {
  if (req.path === '/access' || req.path === '/logout' || req.path.startsWith('/api/')) return next();
  if (!websiteAccessCode()) {
    res.set('Cache-Control', 'no-store');
    return res.status(503).send(accessPage('Website access is not configured yet. Set WEBSITE_ACCESS_CODE in Render.'));
  }
  if (!hasWebsiteAccess(req)) return res.redirect('/access');
  return next();
});

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
// Supported football values: 1x2, gg, dc, dnb, ou05, ou15, ou45, ah, oneup. O/U 2.5 is intentionally not used by the Auto Builder.
app.get('/api/sportybet/odds', async (req, res) => {
  try {
    const kind = String(req.query.market || '1x2').toLowerCase();
    if (!['1x2', 'gg', 'dc', 'dnb', 'ou05', 'ou15', 'ou45', 'ah', 'oneup', 'corners', 'first_half_team_corners'].includes(kind)) {
      return res.status(400).json({ error: 'market must be one of: 1x2, gg, dc, dnb, ou05, ou15, ou45, ah, oneup, corners, first_half_team_corners' });
    }
    const payload = await loadSportyBetMarket(kind);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(payload);
  } catch (err) {
    console.error('SportyBet odds error:', err.message);
    const status = err.code === 'PARSE_API_KEY_MISSING' ? 503 : (err.code === 'SPORTYBET_BOOKING_TIMEOUT' ? 504 : 502);
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

async function loadAutoCandidates({ sportScope = 'all', minProbability = 55, minEdge = 0, leagues = null, betTypes = null, marketHours = null, marketMaxPages = null, marketCacheOnly = false } = {}) {
  const scope = normalizeSportScope(sportScope);
  const wantsFootball = scope === 'all' || scope === 'football';
  const wantsBasketball = scope === 'all' || scope === 'basketball';
  const wantsHockey = scope === 'all' || scope === 'hockey';

  // Fetch only the market families actually requested. Previously, even a one-market
  // Analyzer request could fan out to every football/basketball/hockey market.
  const requestedBetTypes = Array.isArray(betTypes) && betTypes.length ? new Set(betTypes.map(String)) : null;
  const wantsAny = ids => !requestedBetTypes || ids.some(id => requestedBetTypes.has(id));
  const needF1x2 = wantsFootball && wantsAny(['home_win','draw','away_win']);
  const needFGg = wantsFootball && wantsAny(['gg_yes','ng_no']);
  const needFDc = wantsFootball && wantsAny(['dc_1x','dc_x2']);
  const needFDnb = wantsFootball && wantsAny(['dnb']);
  const needFOu05 = wantsFootball && wantsAny(['over05']);
  const needFOu15 = wantsFootball && wantsAny(['over15']);
  const needFOu45 = wantsFootball && wantsAny(['under45']);
  const needFAh = wantsFootball && wantsAny(['ah_0','ah_plus025','ah_minus025']);
  const needFCorners = wantsFootball && wantsAny(['corners_over','corners_under']);
  const needF1hCorners = false;
  const needFOneup = false;
  const needBasketballWinner = wantsBasketball && wantsAny(['basketball_winner']);
  const needBasketballTotals = wantsBasketball && wantsAny(['basketball_over','basketball_under']);
  const needHockeyWinner = wantsHockey && wantsAny(['hockey_winner']);
  const needHockeyTotals = wantsHockey && wantsAny(['hockey_over','hockey_under']);

  // The general sportsbook cache may live for hours to save API credits, but the Auto Builder
  // needs much fresher availability data so expired events cannot remain eligible.
  const autoMaxCacheAgeSeconds = Math.max(0, parseInt(process.env.AUTO_SPORTYBET_MAX_CACHE_AGE_SECONDS || '43200', 10));
  const autoMarketOptions = {
    hours: marketHours || undefined,
    maxPages: marketMaxPages || undefined,
    maxCacheAgeSeconds: autoMaxCacheAgeSeconds,
    kickoffBufferSeconds: Math.max(0, parseInt(process.env.SPORTYBET_KICKOFF_BUFFER_SECONDS || '60', 10)),
    cacheOnly: !!marketCacheOnly,
  };

  // Do not let one unavailable Parse.bot market family kill the complete Auto/Telegram pool.
  // This is particularly important for corners: the managed NG API may return zero corner rows
  // and older code then falls back to full-market endpoints that may not exist on the current
  // single Parse API subscription.
  const safeMarket = async (label, enabled, fn, emptyValue = { rows: [] }) => {
    if (!enabled) return emptyValue;
    try {
      return await fn();
    } catch (err) {
      console.error(`[Auto candidates] ${label} unavailable: ${err.message}`);
      return { ...emptyValue, rows: Array.isArray(emptyValue.rows) ? emptyValue.rows : [], error: err.message };
    }
  };

  let [predictions, f1x2, fgg, fdc, fdnb, fou05, fou15, fou45, fah, fcorners, f1hteamcorners, foneup, basketballWinner, basketballTotals, hockeyWinner, hockeyTotals] = await Promise.all([
    safeMarket('football predictions', wantsFootball, () => loadPredictions(), { matches: [] }),
    safeMarket('football 1X2', needF1x2, () => loadSportyBetMarket('1x2', 'football', autoMarketOptions)),
    safeMarket('football GG/NG', needFGg, () => loadSportyBetMarket('gg', 'football', autoMarketOptions)),
    safeMarket('football Double Chance', needFDc, () => loadSportyBetMarket('dc', 'football', autoMarketOptions)),
    safeMarket('football Draw No Bet', needFDnb, () => loadSportyBetMarket('dnb', 'football', autoMarketOptions)),
    safeMarket('football Over 0.5', needFOu05, () => loadSportyBetMarket('ou05', 'football', autoMarketOptions)),
    safeMarket('football Over 1.5', needFOu15, () => loadSportyBetMarket('ou15', 'football', autoMarketOptions)),
    safeMarket('football Under 4.5', needFOu45, () => loadSportyBetMarket('ou45', 'football', autoMarketOptions)),
    safeMarket('football Asian Handicap', needFAh, () => loadSportyBetMarket('ah', 'football', autoMarketOptions)),
    safeMarket('football Corners', needFCorners, () => loadSportyBetMarket('corners', 'football', autoMarketOptions)),
    safeMarket('football 1H team corners', needF1hCorners, () => loadSportyBetMarket('first_half_team_corners', 'football', autoMarketOptions)),
    safeMarket('football 1UP', needFOneup, () => loadSportyBetMarket('oneup', 'football', autoMarketOptions)),
    safeMarket('basketball winner', needBasketballWinner, () => loadSportyBetMarket('winner', 'basketball', autoMarketOptions)),
    safeMarket('basketball totals', needBasketballTotals, () => loadSportyBetMarket('totals', 'basketball', autoMarketOptions)),
    safeMarket('hockey winner', needHockeyWinner, () => loadSportyBetMarket('winner', 'hockey', autoMarketOptions)),
    safeMarket('hockey totals', needHockeyTotals, () => loadSportyBetMarket('totals', 'hockey', autoMarketOptions)),
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
    footballMarkets: { '1x2': f1x2, gg: fgg, dc: fdc, dnb: fdnb, ou05: fou05, ou15: fou15, ou45: fou45, ah: fah, corners: fcorners, first_half_team_corners: f1hteamcorners, oneup: foneup },
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


async function prepareAutoCandidatePool({
  sportScope='all',
  minProbability=0,
  minEdge=0,
  leagues=null,
  betTypes=null,
  maxMatchOdds=null,
  marketHours=null,
  marketMaxPages=null,
} = {}) {
  // Single source of truth for Website + Telegram AI candidate eligibility.
  // Keeping the complete filtering path here prevents one surface from finding
  // selections while another reports zero for the same settings.
  const sport = normalizeSportScope(sportScope);
  const probabilityFloor = Math.min(95, Math.max(0, Number(minProbability) || 0));
  const edgeFloor = Math.min(50, Math.max(-25, Number(minEdge) || 0));

  const rawCandidates = await loadAutoCandidates({
    sportScope: sport,
    minProbability: probabilityFloor,
    minEdge: edgeFloor,
    leagues,
    betTypes,
    marketHours,
    marketMaxPages,
  });

  const redFlagSafe = rawCandidates.filter(passesRedFlagFilter);
  const maxOdd = Number(maxMatchOdds);
  const oddsSafe = Number.isFinite(maxOdd) && maxOdd > 1
    ? redFlagSafe.filter(c => Number.isFinite(Number(c.odds)) && Number(c.odds) <= maxOdd)
    : redFlagSafe;

  return {
    sport,
    candidates: oddsSafe,
    diagnostics: {
      rawCandidates: rawCandidates.length,
      redFlagRejected: rawCandidates.length - redFlagSafe.length,
      afterRedFlag: redFlagSafe.length,
      afterMaxOdds: oddsSafe.length,
      minProbability: probabilityFloor,
      minEdge: edgeFloor,
      maxMatchOdds: Number.isFinite(maxOdd) && maxOdd > 1 ? maxOdd : null,
      betTypes: Array.isArray(betTypes) ? betTypes.map(String) : null,
    },
  };
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

function analyzerBetTypesFromBooking(rows, sportScope) {
  const set = new Set();
  let uncertain = false;
  for (const leg of rows || []) {
    const text = analyzerNormText(`${leg.marketDesc || ''} ${leg.outcomeDesc || ''} ${leg.specifier || ''}`);
    if (sportScope === 'basketball') {
      if (/over/.test(text)) set.add('basketball_over');
      else if (/under/.test(text)) set.add('basketball_under');
      else if (/winner|moneyline|money line|match winner|home|away/.test(text)) set.add('basketball_winner');
      else uncertain = true;
      continue;
    }
    if (sportScope === 'hockey') {
      if (/over/.test(text)) set.add('hockey_over');
      else if (/under/.test(text)) set.add('hockey_under');
      else if (/winner|moneyline|money line|match winner|home|away/.test(text)) set.add('hockey_winner');
      else uncertain = true;
      continue;
    }
    if (sportScope === 'football') {
      if (/corner/.test(text)) {
        if (/1st half|first half|1h/.test(text)) {
          set.add('corners_over'); set.add('corners_under');
        } else { set.add('corners_over'); set.add('corners_under'); }
      } else if (/over 0 5/.test(text)) set.add('over05');
      else if (/over 1 5/.test(text)) set.add('over15');
      else if (/under 4 5/.test(text)) set.add('under45');
      else if (/both teams to score|btts| gg /.test(` ${text} `)) { set.add('gg_yes'); set.add('ng_no'); }
      else if (/double chance|1x|x2/.test(text)) { set.add('dc_1x'); set.add('dc_x2'); }
      else if (/draw no bet|dnb/.test(text)) set.add('dnb');
      else if (/asian handicap|handicap/.test(text)) { set.add('ah_0'); set.add('ah_plus025'); set.add('ah_minus025'); }
      else if (/1x2|match result|home win|away win|draw/.test(text)) { set.add('home_win'); set.add('draw'); set.add('away_win'); }
      else if (isAnalyzerOverUnderMarket(leg.marketDesc) && isGenericAnalyzerSelection(leg.outcomeDesc)) {
        set.add('over15'); // known SportyBet get_booking repair path
      } else uncertain = true;
    } else {
      uncertain = true;
    }
  }
  // If any leg is ambiguous, use the full sport set for correctness rather than guessing.
  if (uncertain || !set.size) return null;
  return [...set];
}

app.post('/api/sportybet/analyze-code', express.json(), async (req, res) => {
  try {
    const bookingCode = String(req.body?.bookingCode || '').trim().toUpperCase();
    const minProbability = Math.min(95, Math.max(0, Number(req.body?.minProbability) || 55));
    const horizonDays = [7, 14, 21].includes(Number(req.body?.horizonDays)) ? Number(req.body.horizonDays) : Math.max(7, Math.min(21, parseInt(process.env.ANALYZER_DAYS || '14', 10)));
    const analyzerHours = horizonDays * 24;
    const analyzerMaxPages = Math.max(1, Math.min(4, parseInt(process.env.ANALYZER_MAX_PAGES || '2', 10)));
    if (!bookingCode) return res.status(400).json({ error: 'Enter a SportyBet booking code' });

    const startedAt = Date.now();
    console.log(`[Analyzer] start code=${bookingCode} horizon=${horizonDays}d`);
    const booking = await getBooking(bookingCode);
    console.log(`[Analyzer] booking loaded in ${Date.now()-startedAt}ms`);
    const decodedRows = extractBookingOutcomes(booking).map(normalizeBookingLeg).filter(x => x.home || x.away || x.eventId);
    if (!decodedRows.length) return res.status(404).json({ error: 'The booking code was found, but no selections could be read from it' });

    // Determine sport BEFORE loading extra markets. The old path always loaded football
    // Over 1.5 even for Basketball/Hockey codes, adding unnecessary latency/failure risk.
    const decodedSports = decodedRows.map(x => analyzerNormText(x.sport)).filter(Boolean);
    let analyzerSportScope = 'all';
    if (decodedSports.length && decodedSports.every(x => x.includes('football') || x.includes('soccer'))) analyzerSportScope = 'football';
    else if (decodedSports.length && decodedSports.every(x => x.includes('basket'))) analyzerSportScope = 'basketball';
    else if (decodedSports.length && decodedSports.every(x => x.includes('hockey') || x.includes('ice hockey'))) analyzerSportScope = 'hockey';

    const needsOver15Repair = analyzerSportScope === 'football' && decodedRows.some(
      leg => isAnalyzerOverUnderMarket(leg.marketDesc) && isGenericAnalyzerSelection(leg.outcomeDesc)
    );
    const analyzerOver15 = needsOver15Repair
      ? await loadSportyBetMarket('ou15', 'football', { hours: analyzerHours, maxPages: analyzerMaxPages })
      : { rows: [] };
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
    // Do not fan out to every sport when the imported booking clearly identifies one sport.
    // On Render, loading football + basketball + hockey across a 14/21-day analyzer horizon
    // can create many simultaneous upstream requests and the proxy may close the connection,
    // which the browser reports only as "NetworkError when attempting to fetch resource".
    const analyzerBetTypes = analyzerBetTypesFromBooking(sourceRows, analyzerSportScope);
    console.log(`[Analyzer] scope=${analyzerSportScope} legs=${sourceRows.length} betTypes=${analyzerBetTypes ? analyzerBetTypes.join(',') : 'all-supported'}`);
    const candidateStartedAt = Date.now();
    const candidates = await loadAutoCandidates({
      sportScope: analyzerSportScope,
      minProbability: 0,
      minEdge: -25,
      leagues: null,
      betTypes: analyzerBetTypes,
      marketHours: analyzerHours,
      marketMaxPages: analyzerMaxPages
    });
    console.log(`[Analyzer] candidates=${candidates.length} loaded in ${Date.now()-candidateStartedAt}ms total=${Date.now()-startedAt}ms`);
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
    console.error('SportyBet analyzer error:', err.code || '', err.message);
    const status = err.code === 'INVALID_BOOKING_CODE' ? 400
      : err.code === 'PARSE_API_KEY_MISSING' ? 503
      : (err.code === 'PARSE_TIMEOUT' || err.name === 'AbortError') ? 504
      : 502;
    const publicReason = err.code === 'PARSE_TIMEOUT'
      ? 'SportyBet/Parse timed out while loading the booking or its markets'
      : err.status
        ? `SportyBet/Parse returned HTTP ${err.status}`
        : 'The analyzer could not finish loading the required SportyBet markets';
    res.status(status).json({
      error: err.code === 'PARSE_API_KEY_MISSING' ? 'SportyBet integration is not configured yet' : 'Could not analyze this booking code',
      reason: publicReason,
      code: err.code || 'ANALYZER_UPSTREAM_FAILURE',
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
    const targetOdds = Math.min(100000, Math.max(1.05, Number(body.targetOdds) || 5));
    // Website Auto Builder probability is user-adjustable.
    const minProbability = Math.min(95, Math.max(0, Number(body.minProbability) || 55));
    const maxSelections = Math.min(40, Math.max(1, parseInt(body.maxSelections || '8', 10)));
    const minEdge = Math.min(50, Math.max(-25, Number(body.minEdge) || 0));
    // Optional website-only ceiling for the bookmaker odds of each individual selection.
    // Null/blank means no per-match odds ceiling.
    const rawMaxMatchOdds = Number(body.maxMatchOdds);
    const maxMatchOdds = Number.isFinite(rawMaxMatchOdds) && rawMaxMatchOdds > 1
      ? Math.min(1000, Math.max(1.01, rawMaxMatchOdds))
      : null;
    const leagues = Array.isArray(body.leagues) ? body.leagues.map(String) : null;
    const sportScope = normalizeSportScope(body.sportScope);
    const betTypes = Array.isArray(body.betTypes) ? body.betTypes.map(String) : null;

    const prepared = await prepareAutoCandidatePool({ sportScope, minProbability, minEdge, leagues, betTypes, maxMatchOdds });
    const oddsFilteredCandidates = prepared.candidates;
    const redFlagSafeCandidatesCount = prepared.diagnostics.afterRedFlag;
    const rawCandidatesCount = prepared.diagnostics.rawCandidates;
    const redFlagRejected = prepared.diagnostics.redFlagRejected;
    const result = selectAutoBet(oddsFilteredCandidates, { targetOdds, maxSelections });
    if (!result.selections.length) {
      const cornerDiagnostics=await autoCornerDiagnostics(betTypes);
      return res.status(404).json({
        error: 'No eligible SportyBet selections matched the requested sport and minimum probability',
        targetOdds,
        minProbability,
        minEdge,
        sportScope,
        requestedBetTypes: betTypes,
        candidateCount: oddsFilteredCandidates.length,
        candidatesBeforeMaxOddsFilter: redFlagSafeCandidatesCount,
        candidatesBeforeRedFlagFilter: rawCandidatesCount,
        redFlagRejected,
        maxMatchOdds,
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
      maxMatchOdds,
      candidatesBeforeMaxOddsFilter: redFlagSafeCandidatesCount,
      candidatesBeforeRedFlagFilter: rawCandidatesCount,
      redFlagRejected,
      betTypes,
      generatedAt: new Date().toISOString(),
      note: 'Value engine: football uses 1X2, Corners O/U, GG/NG, Double Chance, Draw No Bet, Over 1.5, Under 4.5 and Asian Handicap +0/+0.25/-0.25. O/U 2.5 is excluded. DNB/AH use settlement-aware fair odds and EV; basketball/hockey remain no-vig market estimates.',
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
  const sportScope = normalizeSportScope(process.env.TELEGRAM_SPORT_SCOPE || 'all');
  const maxSelections = Math.min(40, Math.max(1, parseInt(process.env.TELEGRAM_MAX_SELECTIONS || '30', 10)));
  const leagues = process.env.TELEGRAM_FOOTBALL_LEAGUES
    ? process.env.TELEGRAM_FOOTBALL_LEAGUES.split(',').map(x => x.trim()).filter(Boolean)
    : null;

  // Telegram-only probability plans.
  // Website Auto Builder behavior is intentionally untouched.
  const plans = [
    { label: '10000', targetOdds: 10000, minProbability: 70 },
    { label: '1000', targetOdds: 1000, minProbability: 70 },
    { label: '20', targetOdds: 20, minProbability: 70 },
    { label: '10', targetOdds: 10, minProbability: 70 },
    { label: '1.30–1.35 SAFE', targetOdds: 1.325, minProbability: 80, minOdds: 1.30, maxOdds: 1.35 },
  ];

  // Load broadly enough that positive/negative edge does not determine Telegram eligibility.
  // Probability is applied per plan below.
  const candidates = await loadAutoCandidates({
    sportScope,
    minProbability: 0,
    minEdge: -25,
    leagues
  });
  const saneCandidates = candidates.filter(passesRedFlagFilter);
  const redFlagRejected = candidates.length - saneCandidates.length;
  if (!saneCandidates.length) throw new Error('No eligible candidates remain after Telegram red-flag protection');

  await sendTelegramMessage([
    '🤖 MATCHDAY ODDS DESK — AUTO PICKS',
    `Scope: ${sportScope.toUpperCase()}`,
    'Targets: 10000, 1000, 20, 10, 1.30–1.35 SAFE',
    '10000x / 1000x / 20x / 10x: minimum probability 70%',
    'SAFE: minimum probability 80% | combined odds 1.30–1.35',
    'Positive-edge requirement: OFF',
    'Red-flag protection: ON',
    `Red-flag selections rejected: ${redFlagRejected}`,
    `Candidates scanned: ${candidates.length}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'Model probabilities are estimates, not guarantees.',
  ].join('\n'));

  const output = [];
  for (const plan of plans) {
    const planCandidates = saneCandidates.filter(c => Number(c.probability || 0) >= plan.minProbability);

    if (!planCandidates.length) {
      output.push({ targetOdds: plan.label, error: `No selections met the ${plan.minProbability}% probability minimum` });
      await sendTelegramMessage(`⚠️ ${plan.label} odds set NOT GENERATED — no selections met the ${plan.minProbability}% probability minimum.`);
      continue;
    }

    const result = selectAutoBet(planCandidates, {
      targetOdds: plan.targetOdds,
      maxSelections,
      trials: Number(process.env.TELEGRAM_PICK_TRIALS || 2200),
      minQualityScore: 0,
      requirePositiveEV: false,
    });

    if (!result.selections.length) {
      output.push({ targetOdds: plan.label, error: 'No eligible combination found' });
      await sendTelegramMessage(`⚠️ Could not build the ${plan.label} odds slip from the qualifying selections.`);
      continue;
    }

    // SAFE must actually land inside 1.30–1.35. Do not send a closest-outside-range slip.
    if (plan.minOdds != null && plan.maxOdds != null &&
        (Number(result.combinedOdds) < plan.minOdds || Number(result.combinedOdds) > plan.maxOdds)) {
      output.push({
        targetOdds: plan.label,
        combinedOdds: result.combinedOdds,
        error: 'No qualifying combination landed inside 1.30–1.35'
      });
      await sendTelegramMessage(`⚠️ ${plan.label} set NOT GENERATED — no qualifying combination landed inside 1.30–1.35.`);
      continue;
    }

    try {
      const booking = await bookBet(result.selections.map(x => ({
        eventId: x.eventId,
        marketId: x.marketId,
        outcomeId: x.outcomeId,
        ...(x.specifier ? { specifier: x.specifier } : {}),
      })));
      await sendTelegramMessage(telegramSlipText(plan.label, result, booking, sportScope));

      await trackTelegramSlip(await getRedis(), {
        shareCode: booking?.shareCode,
        shareURL: booking?.shareURL,
        targetOdds: plan.label,
        combinedOdds: result.combinedOdds,
        sportScope,
        selections: result.selections,
      });

      output.push({
        targetOdds: plan.label,
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
      output.push({ targetOdds: plan.label, combinedOdds: result.combinedOdds, error: err.message });
      await sendTelegramMessage(`⚠️ ${plan.label} odds slip was built at ${result.combinedOdds}, but SportyBet code generation failed: ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 750));
  }

  return {
    sportScope,
    plans: plans.map(p => ({
      target: p.label,
      minProbability: p.minProbability,
      ...(p.minOdds != null ? { combinedOddsRange: `${p.minOdds.toFixed(2)}-${p.maxOdds.toFixed(2)}` } : {})
    })),
    positiveEdgeRequired: false,
    redFlagProtection: true,
    redFlagRejected,
    maxSelections,
    candidateCount: candidates.length,
    results: output
  };
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

// Copy Hub is isolated from the Auto Builder and disabled by default.
// It only reads public source data + existing booking-code data and stores its own leaderboard state.
app.get('/api/copy/status', async (req, res) => {
  try {
    const redis = await getRedis();
    res.json({
      enabled: copyHubEnabled(),
      persistentStorage: !!redis,
      xConfigured: !!process.env.X_BEARER_TOKEN,
      xDiscoveryMode: 'broad-sportybet-plus-boom',
      xAutomationWorkflowIncluded: true,
      globalCodeOwnership: true,
      sportySocialBatchImport: true,
      rankingWindowDays: Math.max(1, Math.min(365, parseInt(process.env.COPY_HUB_RANKING_DAYS || '30', 10))),
      note: copyHubEnabled()
        ? 'Copy Hub is read-only toward public sources and SportyBet booking data.'
        : 'Copy Hub is installed but disabled. Set COPY_HUB_ENABLED=true when ready.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Copy Hub status unavailable' });
  }
});

app.get('/api/copy/leaderboard', async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    const redis = await getRedis();
    const days = Math.max(1, Math.min(365, Number(req.query.days) || Number(process.env.COPY_HUB_RANKING_DAYS) || 30));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
    const source = ['all','x','sportysocial','telegram','manual'].includes(String(req.query.source || '').toLowerCase())
      ? String(req.query.source).toLowerCase() : 'all';
    const store = await readCopyHubStore(redis);
    const trackedRows = buildLeaderboard(store, { days, limit: 100, source, settledOnly: false });
    const leaderboard = buildLeaderboard(store, { days, limit, source, settledOnly: true });
    const trackedPunterCount = trackedRows.length;
    const trackedCodeCount = trackedRows.reduce((n,x)=>n+Number(x.codes||0),0);
    const pendingCodeCount = trackedRows.reduce((n,x)=>n+Number(x.pending||0),0);
    const settledCodeCount = trackedRows.reduce((n,x)=>n+Number(x.settled||0),0);
    res.json({ days, source, count: leaderboard.length, trackedPunterCount, trackedCodeCount, pendingCodeCount, settledCodeCount, leaderboard });
  } catch (err) {
    console.error('Copy Hub leaderboard error:', err.message);
    res.status(500).json({ error: 'Could not load Copy Hub leaderboard' });
  }
});

app.get('/api/copy/punter/:id', async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    const redis = await getRedis();
    const profile = await getPunterProfile(redis, String(req.params.id || ''), Number(req.query.days) || 90);
    if (!profile) return res.status(404).json({ error: 'Punter not found' });
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: 'Could not load punter profile' });
  }
});

// Protected manual importer. Useful for SportySocial/Telegram seeds before automatic collectors are enabled.
app.post('/api/copy/import-code', express.json({ limit: '20kb' }), async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    if (!authorizeCopyHub(req)) return res.status(401).json({ error: 'unauthorized' });
    const bookingCode = String(req.body?.bookingCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{4,24}$/.test(bookingCode)) return res.status(400).json({ error: 'Invalid booking code' });
    const booking = await getBooking(bookingCode); // validates through the existing SportyBet adapter
    const redis = await getRedis();
    const result = await addObservedCode(redis, {
      punter: {
        source: req.body?.source,
        username: req.body?.username,
        displayName: req.body?.displayName,
        profileUrl: req.body?.profileUrl,
        sourceUserId: req.body?.sourceUserId,
      },
      bookingCode,
      booking,
      sourcePostId: req.body?.sourcePostId,
      sourceUrl: req.body?.sourceUrl,
      publishedAt: req.body?.publishedAt,
      sourceText: req.body?.sourceText,
    });
    res.json({ ok: true, created: result.created, entry: result.entry });
  } catch (err) {
    console.error('Copy Hub import error:', err.message);
    res.status(400).json({ error: 'Could not import booking code', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
  }
});


// Protected endpoint used by the twice-daily GitHub Playwright collector.
// It accepts only sanitized SportySocial feed records; credentials/cookies never reach Render.
app.post('/api/copy/sportysocial/import-batch', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    if (!authorizeCopyHub(req)) return res.status(401).json({ error: 'unauthorized' });
    const redis = await getRedis();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'No SportySocial items supplied' });
    const result = await importSportySocialBatch(redis, items);
    res.json({ ok: true, source: 'sportysocial', ...result });
  } catch (err) {
    console.error('Copy Hub SportySocial import error:', err.message);
    res.status(400).json({ error: 'Could not import SportySocial batch', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
  }
});

// Official X API only: no cookie scraping, passwords, browser sessions, or account automation.
app.post('/api/copy/x/scan', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    if (!authorizeCopyHub(req)) return res.status(401).json({ error: 'unauthorized' });
    const redis = await getRedis();
    const result = await scanXRecent({
      redis,
      getBooking,
      query: req.body?.queries || req.body?.query,
      maxResults: req.body?.maxResults || process.env.X_COPY_MAX_RESULTS || 25,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Copy Hub X scan error:', err.message);
    const status = err.code === 'X_NOT_CONFIGURED' ? 503 : (err.status === 429 ? 429 : 502);
    res.status(status).json({ error: err.code === 'X_NOT_CONFIGURED' ? 'X API is not configured' : 'X scan failed', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
  }
});

app.post('/api/copy/check-settlements', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    if (!authorizeCopyHub(req)) return res.status(401).json({ error: 'unauthorized' });
    const redis = await getRedis();
    const result = await settleCopyHubPending({
      redis,
      getBooking,
      evaluateBooking,
      maxChecks: req.body?.maxChecks || process.env.COPY_HUB_MAX_SETTLEMENT_CHECKS || 20,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Copy Hub settlement error:', err.message);
    res.status(502).json({ error: 'Copy Hub settlement check failed', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
  }
});

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



function telegramAiAdminIds() {
  return new Set(String(process.env.TELEGRAM_ADMIN_IDS || process.env.TELEGRAM_ADMIN_ID || '')
    .split(',').map(x => x.trim()).filter(Boolean));
}

function telegramAiIsAdmin(id) { return telegramAiAdminIds().has(String(id)); }

function telegramAiUpgradeText(plan, feature) {
  const label = plan.id === 'free' ? 'Pro or Elite' : 'Elite';
  return `🔒 ${feature} is not included in your ${plan.name} plan.\n\nUpgrade to ${label} to unlock higher limits and more Matchday AI tools.`;
}

function telegramAiAccountText(user) {
  const plan = getTelegramAiPlan(user);
  const expiry = user.planExpiresAt ? new Date(user.planExpiresAt).toISOString().slice(0,10) : 'No expiry';
  return [
    '👤 MY MATCHDAY AI ACCOUNT', '',
    `Plan: ${plan.name}${plan.priceNgn ? ` — ₦${plan.priceNgn.toLocaleString()}/month` : ''}`,
    ...(user.plan !== 'free' ? [`Renews/expires: ${expiry}`] : []),
    `Tickets today: ${user.ticketsUsed}/${plan.dailyTickets}`,
    `Purchased extra tickets: ${Number(user.extraTickets||0)}`,
    `Code analyses today: ${user.analyzesUsed}/${plan.dailyAnalyzes}`,
    `AI chat messages today: ${Number(user.llmMessagesUsed||0)}/${plan.dailyLlmMessages}`,
    `Maximum target odds: ${plan.maxTargetOdds}x`,
    `Maximum selections: ${plan.maxSelections}`,
    `Sports: ${plan.sports.map(x => x === 'hockey' ? 'Ice Hockey' : x[0].toUpperCase()+x.slice(1)).join(', ')}`,
  ].join('\n');
}

function telegramAiTicketText(result, booking, request, plan) {
  const lines = [
    `🤖 MATCHDAY AI — ${request.safe ? 'SAFE' : `${Number(request.targetOdds).toFixed(request.targetOdds < 2 ? 2 : 0)}x`} TICKET`,
    `${result.reachedTarget ? '✅ TARGET REACHED' : '🟡 CLOSEST AVAILABLE'} | ${String(request.sport || 'all').toUpperCase()}`,
    `Plan: ${plan.name}`,
    `Actual odds: ${Number(result.combinedOdds || 1).toFixed(2)}`,
    `Selections: ${result.selections.length}`,
    `Average leg probability: ${Number(result.averageProbability || 0).toFixed(1)}%`,
    `Minimum leg probability: ${Number(result.minimumProbability || 0).toFixed(1)}%`,
    `Average quality: ${Number(result.averageQualityScore || 0).toFixed(1)}/100`,
    `SportyBet code: ${booking?.shareCode || 'Code generation unavailable'}`,
    ''
  ];
  result.selections.forEach((x, i) => {
    lines.push(`${i+1}. [${x.sport}] ${x.home} vs ${x.away}`);
    lines.push(`   ${x.outcomeDesc || x.marketDesc} @ ${Number(x.odds).toFixed(2)} | ${Number(x.probability||0).toFixed(1)}% | Q ${Number(x.qualityScore||0).toFixed(1)}`);
  });
  if (booking?.shareURL) lines.push('', `SportyBet link: ${booking.shareURL}`);
  lines.push('', 'Probabilities are model estimates, not guarantees.');
  return lines.join('\n');
}

function telegramAiBetTypesForSport(planId, sport) {
  const allowed = new Set(telegramAiAllowedBetIdsForPlan(planId));
  const bySport = {
    football: ['home_win','draw','away_win','corners_over','corners_under','dc_1x','dc_x2','dnb','over05','over15','under45','gg_yes','ng_no','ah_0','ah_plus025','ah_minus025'],
    basketball: ['basketball_winner','basketball_over','basketball_under'],
    hockey: ['hockey_winner','hockey_over','hockey_under'],
  };
  if (sport === 'all') return [...allowed];
  return (bySport[sport] || []).filter(id => allowed.has(id));
}

function telegramAiMergeTicketRequest(user, incoming) {
  const saved = user?.preferences?.builder || {};
  const inc = incoming || {};
  const merged = { ...saved, ...inc };
  const plan = getTelegramAiPlan(user);
  const requestedSport = inc.sport ? normalizeSportScope(inc.sport) : normalizeSportScope(merged.sport || 'football');
  const explicitBetTypes = Array.isArray(inc.betTypes) && inc.betTypes.length > 0;

  if (explicitBetTypes) {
    merged.betTypes = inc.betTypes;
  } else if (inc.sport) {
    // A fresh natural-language sport request must not inherit incompatible markets
    // from the previous ticket (e.g. football corners -> hockey).
    merged.betTypes = telegramAiBetTypesForSport(plan.id, requestedSport);
  } else if (!Array.isArray(merged.betTypes) || !merged.betTypes.length) {
    merged.betTypes = telegramAiBetTypesForSport(plan.id, requestedSport);
  }
  return merged;
}

async function buildTelegramAiTicket(user, request) {
  const plan = getTelegramAiPlan(user);
  const saved = user?.preferences?.builder || {};
  const merged = { ...saved, ...(request || {}) };
  let sport = normalizeSportScope(merged.sport || (plan.id === 'free' ? 'football' : 'all'));
  if (!plan.sports.includes(sport)) {
    return { locked: true, message: telegramAiUpgradeText(plan, `${sport === 'hockey' ? 'Ice Hockey' : sport} tickets`) };
  }
  const targetOdds = Number(merged.targetOdds || 10);
  if (targetOdds > plan.maxTargetOdds) {
    return { locked: true, message: `${telegramAiUpgradeText(plan, `${targetOdds}x ticket building`)}\n\nYour current maximum target is ${plan.maxTargetOdds}x.` };
  }
  const minProbability = Math.min(95, Math.max(merged.safe ? 80 : 0, Number(merged.minProbability ?? (merged.safe ? 80 : 70))));
  const minEdge = Math.min(25, Math.max(-10, Number(merged.minEdge ?? 0)));
  const maxSelections = Math.min(plan.maxSelections, Math.max(1, Number(merged.maxSelections || plan.maxSelections)));
  const allowedBetTypes = new Set(telegramAiAllowedBetIdsForPlan(plan.id));
  const sportBetTypes = new Set(telegramAiBetTypesForSport(plan.id, sport));
  let requestedBetTypes = Array.isArray(merged.betTypes) && merged.betTypes.length ? merged.betTypes.map(String) : [...sportBetTypes];
  let betTypes = requestedBetTypes.filter(id => allowedBetTypes.has(id) && (sport === 'all' || sportBetTypes.has(id)));
  // Basketball/Hockey only have three supported families. Old saved preferences could
  // contain a partial/corrupted list even though the Builder displayed “(3)”.
  // When all selected IDs are sport-compatible, normalize them to the canonical IDs.
  if (sport === 'basketball' && betTypes.length && betTypes.every(id => id.startsWith('basketball_'))) {
    betTypes = telegramAiBetTypesForSport(plan.id, 'basketball');
  }
  if (sport === 'hockey' && betTypes.length && betTypes.every(id => id.startsWith('hockey_'))) {
    betTypes = telegramAiBetTypesForSport(plan.id, 'hockey');
  }
  if (!betTypes.length) {
    return { error: `None of the selected bet types are compatible with ${sport === 'hockey' ? 'Ice Hockey' : sport}. Choose a compatible market or ask for the sport without specifying a bet type.` };
  }
  const prepared = await prepareAutoCandidatePool({
    sportScope: sport,
    minProbability,
    minEdge,
    leagues: null,
    betTypes,
    maxMatchOdds: merged.maxMatchOdds,
  });
  const pool = prepared.candidates;
  if (!pool.length) {
    const d = prepared.diagnostics;
    console.warn(`[Telegram AI pool] sport=${sport} raw=${d.rawCandidates} afterRedFlag=${d.afterRedFlag} afterMaxOdds=${d.afterMaxOdds} minProb=${minProbability} minEdge=${minEdge} betTypes=${betTypes.join(',')}`);
    return { error: `No current SportyBet selections passed your ${minProbability}% probability rule, ${minEdge} edge setting and red-flag protection. (Candidates: ${d.rawCandidates} raw, ${d.afterRedFlag} after red flags, ${d.afterMaxOdds} after max-odd filter.)` };
  }
  const result = selectAutoBet(pool, {
    targetOdds: merged.safe ? 1.325 : targetOdds,
    maxSelections,
    trials: Number(process.env.TELEGRAM_AI_PICK_TRIALS || 1800),
    minQualityScore: 0,
    requirePositiveEV: false,
  });
  if (!result?.selections?.length) return { error: 'I could not find a qualifying combination from the current SportyBet fixtures.' };
  if (merged.safe && (Number(result.combinedOdds) < 1.30 || Number(result.combinedOdds) > 1.35)) {
    return { error: 'No SAFE combination currently lands inside 1.30–1.35 while keeping every leg at 80%+.' };
  }
  const booking = await bookBet(result.selections.map(x => ({ eventId:x.eventId, marketId:x.marketId, outcomeId:x.outcomeId, ...(x.specifier ? {specifier:x.specifier}: {}) })));
  return { result, booking, plan, request: { ...merged, sport, targetOdds, minProbability, minEdge, maxSelections, betTypes } };
}

function telegramAnalyzerSameFixture(leg, c) {
  if (leg.eventId && c.eventId) return String(leg.eventId) === String(c.eventId);
  const direct = analyzerTeamMatch(leg.home, c.home) && analyzerTeamMatch(leg.away, c.away);
  const reverse = analyzerTeamMatch(leg.home, c.away) && analyzerTeamMatch(leg.away, c.home);
  return direct || reverse;
}

function telegramAnalyzerReplacementFor(leg, candidates, minProbability) {
  return candidates
    .filter(c => telegramAnalyzerSameFixture(leg, c))
    .filter(c => Number(c.probability || 0) >= Number(minProbability || 0))
    .filter(passesRedFlagFilter)
    .sort((a,b) => {
      const p = Number(b.probability||0) - Number(a.probability||0); if (p) return p;
      const q = Number(b.qualityScore||0) - Number(a.qualityScore||0); if (q) return q;
      const e = Number(b.edge||0) - Number(a.edge||0); if (e) return e;
      return Number(a.odds||99) - Number(b.odds||99);
    })[0] || null;
}

async function analyzeTelegramAiCode(bookingCode, minProbability = 70, horizonDays = 14, replaceUnsupported = false) {
  horizonDays = Math.min(21, Math.max(7, Number(horizonDays) || 14));
  const analyzerHours = horizonDays * 24;
  const booking = await getBooking(bookingCode);
  const decodedRows = extractBookingOutcomes(booking).map(normalizeBookingLeg).filter(x => x.home || x.away || x.eventId);
  if (!decodedRows.length) throw new Error('The SportyBet code was found, but no selections could be read from it.');

  const decodedSports = decodedRows.map(x => analyzerNormText(x.sport)).filter(Boolean);
  let sportScope = 'all';
  if (decodedSports.length && decodedSports.every(x => x.includes('football') || x.includes('soccer'))) sportScope = 'football';
  else if (decodedSports.length && decodedSports.every(x => x.includes('basket'))) sportScope = 'basketball';
  else if (decodedSports.length && decodedSports.every(x => x.includes('hockey') || x.includes('ice hockey'))) sportScope = 'hockey';

  // Only use the Daily Refresh/shared cache for market matching and replacement. get_booking
  // remains the one live lookup needed to decode the submitted code.
  const analyzerOver15 = sportScope === 'football'
    ? await loadSportyBetMarket('ou15', 'football', { hours: analyzerHours, maxPages: 2, cacheOnly: true })
    : { rows: [] };
  const sourceRows = decodedRows.map(leg => resolveGenericOver15Leg(leg, analyzerOver15?.rows));

  // Load the full supported market universe for the booking's sport from cache only.
  // This lets an unsupported imported market be replaced by another supported saved
  // market on the exact same fixture without spending new Parse.bot market credits.
  const candidates = await loadAutoCandidates({
    sportScope, minProbability:0, minEdge:-25, leagues:null, betTypes:null,
    marketHours:analyzerHours, marketMaxPages:2, marketCacheOnly:true
  });

  const analyzed = sourceRows.map((leg, index) => {
    let best=null, bestScore=-1;
    const exact = leg.eventId ? candidates.filter(c => String(c.eventId||'') === String(leg.eventId)) : [];
    for (const c of (exact.length ? exact : candidates)) {
      const score=analyzerCandidateScore(leg,c); if(score>bestScore){bestScore=score;best=c;}
    }
    if (!best || bestScore < 60) {
      if (replaceUnsupported) {
        const replacement = telegramAnalyzerReplacementFor(leg, candidates, minProbability);
        if (replacement) {
          return {
            index, ...leg, supported:true, qualified:true, replaced:true,
            originalMarketDesc: leg.marketDesc, originalOutcomeDesc: leg.outcomeDesc, originalOdds: leg.odds,
            eventId:String(replacement.eventId||leg.eventId||''), marketId:String(replacement.marketId||''), outcomeId:String(replacement.outcomeId||''), specifier:replacement.specifier||null,
            sport:replacement.sport||leg.sport, home:replacement.home||leg.home, away:replacement.away||leg.away,
            outcomeDesc:replacement.outcomeDesc, marketDesc:replacement.marketDesc, odds:Number(replacement.odds||0),
            probability:Number(replacement.probability||0), edge:Number(replacement.edge||0), qualityScore:Number(replacement.qualityScore||0),
            replacementReason:'Unsupported imported market replaced from saved/cached data on the same fixture'
          };
        }
      }
      return { index, ...leg, supported:false, qualified:false, replaced:false };
    }
    return { index, ...leg, supported:true, qualified:Number(best.probability||0)>=minProbability, replaced:false, probability:Number(best.probability||0), edge:Number(best.edge||0), qualityScore:Number(best.qualityScore||0), sport:best.sport, home:best.home, away:best.away, outcomeDesc:best.outcomeDesc, marketDesc:best.marketDesc, odds:Number(best.odds||leg.odds||0) };
  });
  return { bookingCode, analyzed, supported: analyzed.filter(x=>x.supported).length, qualified: analyzed.filter(x=>x.qualified).length, replaced: analyzed.filter(x=>x.replaced).length, unsupported: analyzed.filter(x=>!x.supported).length, total: analyzed.length, minProbability, replaceUnsupported:!!replaceUnsupported, cacheOnlyMarkets:true };
}

function telegramAiAnalysisText(a) {
  const lines=[`🔎 MATCHDAY AI CODE ANALYSIS — ${a.bookingCode}`, `Scored: ${a.supported}/${a.total}`, `Qualified ≥ ${a.minProbability}%: ${a.qualified}/${a.total}`, ...(a.replaceUnsupported?[`Replaced from saved data: ${a.replaced||0}`]:[]), ''];
  a.analyzed.forEach((x,i)=>{
    const icon=x.replaced?'♻️':!x.supported?'⚪':x.qualified?'✅':'❌';
    lines.push(`${icon} ${i+1}. ${x.home||'Unknown'} vs ${x.away||'Unknown'}`);
    if (x.replaced) {
      lines.push(`   ORIGINAL: ${x.originalOutcomeDesc||x.originalMarketDesc||'Unsupported selection'}${x.originalOdds?` @ ${Number(x.originalOdds).toFixed(2)}`:''}`);
      lines.push(`   REPLACED → ${x.outcomeDesc||x.marketDesc||'Selection'}${x.odds?` @ ${Number(x.odds).toFixed(2)}`:''} | ${Number(x.probability).toFixed(1)}% | Q ${Number(x.qualityScore||0).toFixed(1)}`);
    } else {
      lines.push(`   ${x.outcomeDesc||x.marketDesc||'Selection'}${x.odds?` @ ${Number(x.odds).toFixed(2)}`:''}${x.supported?` | ${Number(x.probability).toFixed(1)}% | Q ${Number(x.qualityScore||0).toFixed(1)}`:' | NOT SCORED'}`);
    }
  });
  lines.push('', '✅ = keep · ❌ = below threshold · ♻️ = same-fixture cached replacement · ⚪ = unsupported/unresolved');
  lines.push('Cached replacement never switches to a different fixture and does not make a fresh Parse market call.');
  return lines.join('\n');
}

async function sendTelegramAiLongMessage(chatId, text, options = {}) {
  const raw = String(text || '');
  if (raw.length <= 3900) return sendTelegramAiMessageTo(chatId, raw, options);
  const lines = raw.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 3900 && current) { chunks.push(current); current = line; }
    else current = next;
  }
  if (current) chunks.push(current);
  for (let i = 0; i < chunks.length; i++) {
    const opts = i === chunks.length - 1 ? options : {};
    await sendTelegramAiMessageTo(chatId, chunks[i], opts);
  }
}


async function matchdayLlmInterpret(user, message) {
  const apiKey=String(process.env.OPENAI_API_KEY||'').trim();
  if(!apiKey) return null;
  const model=String(process.env.OPENAI_MODEL||'gpt-5.6-luna').trim();
  const plan=getTelegramAiPlan(user);
  const llmLimit=Number(plan.dailyLlmMessages||0);
  const llmUsed=Number(user.llmMessagesUsed||0);
  if(llmLimit>0 && llmUsed>=llmLimit) return {quotaExceeded:true, limit:llmLimit, action:'chat', reply:''};
  user.llmMessagesUsed=llmUsed+1;
  const b=user.preferences?.builder||{};
  const allowed=telegramAiAllowedBetIdsForPlan(plan.id);
  const history=Array.isArray(user.llmHistory)?user.llmHistory.slice(-8):[];
  const instructions=`You are Matchday AI, a concise conversational assistant inside a Telegram sports analytics app.
Never invent fixtures, odds, booking codes, probabilities, results, or model data. The application engine—not you—retrieves and calculates those.
Interpret normal conversation into either a reply or an app action.
Current subscription: ${plan.name}. Allowed sports: ${plan.sports.join(', ')}. Allowed bet type IDs: ${allowed.join(', ')}.
Current builder settings: ${JSON.stringify(b)}.
Valid action values: chat, ticket, builder, plans, account, analyze.
For ticket actions, only set fields the user clearly requested; the app merges them with current settings.
Sport values: football, basketball, hockey, all. Do not bypass subscription restrictions.
Bet IDs: home_win, draw, away_win, oneup, corners_over, corners_under, first_half_home_team_corners, first_half_away_team_corners, dc_1x, dc_x2, dnb, over05, over15, under45, gg_yes, ng_no, ah_0, ah_plus025, ah_minus025, basketball_winner, basketball_over, basketball_under, hockey_winner, hockey_over, hockey_under.
If the user asks to build/rebuild/replace/remove selections but the requested transformation cannot be safely represented by these parameters, explain what can be changed and ask one concise question instead of pretending it was done.
If discussing betting, do not promise wins or guaranteed profit.`;
  const input=[
    ...history.map(x=>({role:x.role==='assistant'?'assistant':'user',content:String(x.content||'')})),
    {role:'user',content:String(message)}
  ];
  const body={
    model,
    instructions,
    input,
    store:false,
    max_output_tokens:500,
    text:{format:{
      type:'json_schema',
      name:'matchday_router',
      strict:true,
      schema:{
        type:'object',
        additionalProperties:false,
        properties:{
          action:{type:'string',enum:['chat','ticket','builder','plans','account','analyze']},
          reply:{type:'string'},
          targetOdds:{type:['number','null']},
          sport:{type:['string','null'],enum:['football','basketball','hockey','all',null]},
          minProbability:{type:['number','null'],minimum:0,maximum:100},
          maxMatchOdds:{type:['number','null']},
          minEdge:{type:['number','null']},
          maxSelections:{type:['integer','null']},
          safe:{type:['boolean','null']},
          betTypes:{type:['array','null'],items:{type:'string'}},
          bookingCode:{type:['string','null']}
        },
        required:['action','reply','targetOdds','sport','minProbability','maxMatchOdds','minEdge','maxSelections','safe','betTypes','bookingCode']
      }
    }}
  };
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'content-type':'application/json','authorization':`Bearer ${apiKey}`},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(20000)
    });
    if(!r.ok){const t=await r.text();throw new Error(`OpenAI ${r.status}: ${t.slice(0,180)}`)}
    const data=await r.json();
    let outText=data.output_text;
    if(!outText){
      for(const item of data.output||[]) for(const c of item.content||[]) if(c.type==='output_text'&&c.text){outText=c.text;break}
    }
    const parsed=JSON.parse(outText||'{}');
    user.llmHistory=[...history,{role:'user',content:String(message)},{role:'assistant',content:String(parsed.reply||'')}].slice(-10);
    return parsed;
  }catch(e){
    console.error('Matchday LLM error:',e.message);
    return null;
  }
}

function llmTicketIntent(x){
  const out={intent:'ticket'};
  for(const k of ['targetOdds','sport','minProbability','maxMatchOdds','minEdge','maxSelections','safe','betTypes']){
    if(x[k]!==null&&x[k]!==undefined) out[k]=x[k];
  }
  return out;
}

async function handleTelegramAiUpdate(update) {
  const callback = update?.callback_query;
  const msg = callback?.message || update?.message;
  if (!msg?.chat?.id) return;
  const chatId = msg.chat.id;
  const from = callback?.from || msg.from || {};
  const redis = await getRedis();
  let user = await getTelegramAiUser(redis, from.id || chatId, from);
  let text = String(msg.text || '').trim();
  let callbackAction = null;

  if (callback) {
    await telegramAiRequest('answerCallbackQuery', { callback_query_id: callback.id }).catch(()=>{});
    const d = String(callback.data || '');

    if (d === 'action:home') text = '/start';
    else if (d === 'action:builder') {
      return sendTelegramAiMessageTo(chatId, telegramAiBuilderSummary(user), { reply_markup: telegramAiBuilderKeyboard(user) });
    }
    else if (d === 'builder:sport') return sendTelegramAiMessageTo(chatId, '🏟 Select the sport scope for this ticket:', { reply_markup: telegramAiSportKeyboard(user) });
    else if (d === 'builder:target') return sendTelegramAiMessageTo(chatId, `🎯 Select target combined odds.\nYour ${getTelegramAiPlan(user).name} maximum is ${getTelegramAiPlan(user).maxTargetOdds}x.`, { reply_markup: telegramAiTargetKeyboard(user) });
    else if (d === 'builder:prob') return sendTelegramAiMessageTo(chatId, '📈 Select the minimum model/fair probability required for every leg:', { reply_markup: telegramAiProbabilityKeyboard() });
    else if (d === 'builder:maxodd') return sendTelegramAiMessageTo(chatId, '💰 Select the maximum SportyBet odd allowed for any individual match:', { reply_markup: telegramAiMaxOddKeyboard() });
    else if (d === 'builder:edge') return sendTelegramAiMessageTo(chatId, '📊 Select the minimum football probability edge. Negative values allow more candidates; positive values demand model value over price:', { reply_markup: telegramAiEdgeKeyboard() });
    else if (d === 'builder:maxgames') return sendTelegramAiMessageTo(chatId, '🔢 Select the maximum number of games the builder can use:', { reply_markup: telegramAiMaxGamesKeyboard(user) });
    else if (d === 'builder:markets') return sendTelegramAiMessageTo(chatId, '🎲 Select the exact bet types the Auto Builder may use. Tap a market to toggle it:', { reply_markup: telegramAiMarketsKeyboard(user) });
    else if (d === 'builder:build') callbackAction = 'build';
    else if (d === 'builder:safe' || d === 'ticket:safe') callbackAction = 'safe';
    else if (d.startsWith('ticket:')) { user.preferences.builder.targetOdds = Number(d.split(':')[1]) || 10; await saveTelegramAiUser(redis,user); callbackAction='build'; }
    else if (d === 'action:plans') text = '/plans';
    else if (d === 'action:account') text = '/account';
    else if (d === 'action:copy') text = 'copy rankings';
    else if (d === 'action:analyze') {
      const plan = getTelegramAiPlan(user);
      if (plan.dailyAnalyzes <= 0) return sendTelegramAiMessageTo(chatId, telegramAiUpgradeText(plan,'SportyBet code analysis'), { reply_markup: telegramAiPlanKeyboard() });
      return sendTelegramAiMessageTo(chatId, telegramAiAnalyzerSummary(user), { reply_markup: telegramAiAnalyzerKeyboard(user) });
    }
    else if (d === 'analyzer:prob') return sendTelegramAiMessageTo(chatId, '📈 Choose the probability threshold used to KEEP selections:', { reply_markup: telegramAiAnalyzerProbKeyboard() });
    else if (d === 'analyzer:horizon') return sendTelegramAiMessageTo(chatId, '📅 How far ahead should Matchday search for fixtures in the imported code?', { reply_markup: telegramAiAnalyzerHorizonKeyboard() });
    else if (d === 'analyzer:replace:last') {
      const last=user.lastAnalyzerRequest;
      if(!last?.bookingCode)return sendTelegramAiMessageTo(chatId,'There is no recent analysis to repair. Analyze a booking code first.',{reply_markup:telegramAiAnalyzerKeyboard(user)});
      await sendTelegramAiMessageTo(chatId,`♻️ Checking saved markets for safe same-fixture replacements in ${last.bookingCode}…`);
      try{
        const repaired=await analyzeTelegramAiCode(last.bookingCode,last.minProbability,last.horizonDays,true);
        user.lastAnalyzerRequest={...last,repairedAt:new Date().toISOString()};await saveTelegramAiUser(redis,user);
        return sendTelegramAiLongMessage(chatId,telegramAiAnalysisText(repaired),{reply_markup:telegramAiAnalyzerAnalysisKeyboard(false)});
      }catch(e){return sendTelegramAiMessageTo(chatId,`⚠️ I could not replace the unsupported selections: ${e.message}`,{reply_markup:telegramAiAnalyzerKeyboard(user)})}
    }
    else if (d === 'analyzer:enter') return sendTelegramAiMessageTo(chatId, `⌨️ Send the SportyBet booking code now.\n\nCurrent analyzer: ≥ ${user.preferences.analyzer.minProbability}% · ${user.preferences.analyzer.horizonDays} days\n\nUnsupported selections will be shown first. Nothing is replaced unless you tap ♻️ Replace Unsupported after the analysis.\nExample: RKT1JT`);
    else if (d.startsWith('set:sport:')) {
      const nextSport=d.split(':')[2];
      user.preferences.builder.sport=nextSport;
      const compatible=telegramAiBetTypesForSport(getTelegramAiPlan(user).id,nextSport);
      const current=(user.preferences.builder.betTypes||[]).filter(id=>compatible.includes(id));
      if(!current.length) user.preferences.builder.betTypes=compatible;
      await saveTelegramAiUser(redis,user);
      return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)});
    }
    else if (d.startsWith('set:target:')) { user.preferences.builder.targetOdds=Number(d.split(':')[2]); user.preferences.builder.safe=false; await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)}); }
    else if (d.startsWith('set:prob:')) { user.preferences.builder.minProbability=Number(d.split(':')[2]); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)}); }
    else if (d.startsWith('set:maxodd:')) { const v=d.split(':')[2]; user.preferences.builder.maxMatchOdds=v==='none'?null:Number(v); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)}); }
    else if (d.startsWith('set:edge:')) { user.preferences.builder.minEdge=Number(d.split(':')[2]); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)}); }
    else if (d.startsWith('set:maxgames:')) { user.preferences.builder.maxSelections=Number(d.split(':')[2]); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)}); }
    else if (d.startsWith('set:anprob:')) { user.preferences.analyzer.minProbability=Number(d.split(':')[2]); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiAnalyzerSummary(user),{reply_markup:telegramAiAnalyzerKeyboard(user)}); }
    else if (d.startsWith('set:horizon:')) { user.preferences.analyzer.horizonDays=Number(d.split(':')[2]); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiAnalyzerSummary(user),{reply_markup:telegramAiAnalyzerKeyboard(user)}); }
    else if (d.startsWith('market:')) {
      const id=d.slice('market:'.length);
      const allowed=new Set(telegramAiAllowedBetIdsForPlan(getTelegramAiPlan(user).id));
      if(!allowed.has(id)) return sendTelegramAiMessageTo(chatId,telegramAiUpgradeText(getTelegramAiPlan(user),'this bet type'),{reply_markup:telegramAiPlanKeyboard()});
      const set=new Set((user.preferences.builder.betTypes||[]).filter(x=>allowed.has(x)));
      if(set.has(id))set.delete(id);else set.add(id); user.preferences.builder.betTypes=[...set]; await saveTelegramAiUser(redis,user);
      return sendTelegramAiMessageTo(chatId,'🎲 Bet types updated. Continue selecting or tap Done.',{reply_markup:telegramAiMarketsKeyboard(user)});
    }
    else if (d === 'markets:all') { user.preferences.builder.betTypes=[...telegramAiAllowedBetIdsForPlan(getTelegramAiPlan(user).id)]; await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,'✅ All bet types available on your plan selected.',{reply_markup:telegramAiMarketsKeyboard(user)}); }
    else if (d === 'markets:clear') { user.preferences.builder.betTypes=[]; await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,'🧹 All markets cleared. Select at least one market before building.',{reply_markup:telegramAiMarketsKeyboard(user)}); }
    else if (d === 'result:rebuild') callbackAction='rebuild';
    else if (d === 'result:safer') callbackAction='safer';
    else if (d.startsWith('locked:')) return sendTelegramAiMessageTo(chatId,telegramAiUpgradeText(getTelegramAiPlan(user),'this Auto Builder option'),{reply_markup:telegramAiPlanKeyboard()});
    else if (d.startsWith('extra:')) {
      const packPlan=d.split(':')[1],current=getTelegramAiPlan(user);
      if(current.id!==packPlan||!['pro','elite'].includes(packPlan))return sendTelegramAiMessageTo(chatId,'Extra ticket packs require an active matching Pro or Elite subscription.',{reply_markup:telegramAiPlanKeyboard(user)});
      const pack=packPlan==='elite'?{count:75,price:'₦10,000'}:{count:25,price:'₦2,500'};
      const admins=[...telegramAiAdminIds()];
      if(!admins.length)return sendTelegramAiMessageTo(chatId,'⚠️ Payment contact is temporarily unavailable. Please try again later.');
      const msg=['🎟️ EXTRA AI TICKET REQUEST','',`Plan: ${current.name}`,`Pack: +${pack.count} tickets`,`Amount: ${pack.price}`,`Customer: ${from.first_name||user.firstName||'Customer'}`,`Username: ${from.username?'@'+from.username:'No username'}`,`Telegram ID: ${from.id}`,'','Confirm payment, then press the button below or use:',`/addtickets ${from.id} ${pack.count}`].join('\n');
      let delivered=0;for(const aid of admins){try{await sendTelegramAiMessageTo(aid,msg,{reply_markup:{inline_keyboard:[[{text:`✅ Add +${pack.count} Tickets`,callback_data:`adminaddtickets:${from.id}:${pack.count}`}]]}});delivered++}catch(e){console.error('Extra-ticket admin notification:',e.message)}}
      if(!delivered)return sendTelegramAiMessageTo(chatId,'⚠️ I could not reach the payment administrator. Please try again shortly.');
      return sendTelegramAiMessageTo(chatId,`✅ Request sent. ${pack.price} for +${pack.count} AI tickets. Tickets are added after payment confirmation and expire with your current subscription.`,{reply_markup:telegramAiMainKeyboard()});
    }
    else if (d.startsWith('plan:')) {
      const chosen=d.split(':')[1];
      if(!['pro','elite'].includes(chosen)) return sendTelegramAiMessageTo(chatId,'Unknown subscription plan.',{reply_markup:telegramAiPlanKeyboard()});
      const planName=chosen==='elite'?'ELITE':'PRO';
      const price=chosen==='elite'?'₦20,000':'₦5,000';
      const username=from.username?`@${from.username}`:'No Telegram username';
      const firstName=from.first_name||user.firstName||'Customer';
      const admins=[...telegramAiAdminIds()];
      if(!admins.length) {
        return sendTelegramAiMessageTo(chatId,'⚠️ Payment contact is temporarily unavailable. Please try again later.',{reply_markup:telegramAiPlanKeyboard()});
      }
      const adminMessage=[
        '💳 NEW MATCHDAY AI PAYMENT REQUEST','',
        `Plan: ${planName}`,
        `Amount: ${price}`,
        `Customer: ${firstName}`,
        `Username: ${username}`,
        `Telegram ID: ${from.id}`,'',
        'The customer selected this plan and is waiting for bank account/payment instructions.','',
        `After confirming payment, activate with:`,
        `/activate ${from.id} ${chosen} 30`
      ].join('\n');
      let delivered=0;
      for(const adminId of admins){
        try{
          await sendTelegramAiMessageTo(adminId,adminMessage,{
            reply_markup:{inline_keyboard:[
              [{text:'💬 Open Customer Chat',url:`tg://user?id=${from.id}`}],
              [{text:`✅ Activate ${planName} 30 Days`,callback_data:`adminactivate:${from.id}:${chosen}:30`}]
            ]}
          });
          delivered++;
        }catch(e){ console.error('Telegram AI payment admin notification failed:',adminId,e.message); }
      }
      if(!delivered) return sendTelegramAiMessageTo(chatId,'⚠️ I could not reach the payment administrator. Please try again shortly.',{reply_markup:telegramAiPlanKeyboard()});
      return sendTelegramAiMessageTo(chatId,[
        `✅ ${planName} payment request sent to the administrator.`,
        '',
        `Plan: ${planName}`,
        `Amount: ${price}`,
        `Your Telegram ID: ${from.id}`,
        '',
        'The administrator will contact you in Telegram with the account/payment details. Do not send payment to account details from anyone else claiming to be Matchday AI.'
      ].join('\n'),{reply_markup:{inline_keyboard:[[{text:'⬅️ Plans',callback_data:'action:plans'}],[{text:'🏠 Home',callback_data:'action:home'}]]}});
    }
    else if (d.startsWith('adminaddtickets:')) {
      if(!telegramAiIsAdmin(from.id))return sendTelegramAiMessageTo(chatId,'Unauthorized.');
      const [,target,countRaw]=d.split(':'),count=Math.max(1,parseInt(countRaw,10)||0);
      const u=await addTelegramAiExtraTickets(redis,target,count);
      await sendTelegramAiMessageTo(chatId,`✅ Added +${count} AI tickets to ${target}. Balance: ${Number(u.extraTickets||0)}.`);
      try{await sendTelegramAiMessageTo(target,`🎟️ Payment confirmed. +${count} extra AI tickets added.\nBalance: ${Number(u.extraTickets||0)}.`,{reply_markup:telegramAiMainKeyboard()})}catch{}
      return;
    }
    else if (d.startsWith('adminactivate:')) {
      if(!telegramAiIsAdmin(from.id)) return sendTelegramAiMessageTo(chatId,'⛔ Admin only.');
      const parts=d.split(':'),target=parts[1],planId=parts[2],days=Math.max(1,Math.min(365,Number(parts[3]||30)));
      if(!/^\d+$/.test(target)||!['pro','elite'].includes(planId)) return sendTelegramAiMessageTo(chatId,'⚠️ Invalid activation request.');
      await activateTelegramAiPlan(redis,target,planId,days);
      await sendTelegramAiMessageTo(chatId,`✅ Activated ${planId.toUpperCase()} for Telegram user ${target} for ${days} days.`);
      await sendTelegramAiMessageTo(target,`🎉 Payment confirmed. Your Matchday AI account is now ${planId.toUpperCase()} for ${days} days.`,{reply_markup:telegramAiMainKeyboard()}).catch(()=>{});
      return;
    }
  }

  const addTicketsCmd=text.match(/^\/addtickets\s+(\d+)\s+(\d+)$/i);
  if(addTicketsCmd&&telegramAiIsAdmin(from.id)){const target=addTicketsCmd[1],count=Math.max(1,parseInt(addTicketsCmd[2],10)||0),u=await addTelegramAiExtraTickets(redis,target,count);await sendTelegramAiMessageTo(chatId,`✅ Added +${count} AI tickets to ${target}. Balance: ${Number(u.extraTickets||0)}.`);try{await sendTelegramAiMessageTo(target,`🎟️ +${count} extra AI tickets have been added. Balance: ${Number(u.extraTickets||0)}.`,{reply_markup:telegramAiMainKeyboard()})}catch{}return}
  const admin=text.match(/^\/activate\s+(\d+)\s+(pro|elite)(?:\s+(\d+))?$/i);
  if(admin&&telegramAiIsAdmin(from.id)){
    const target=admin[1],planId=admin[2].toLowerCase(),days=Math.max(1,Math.min(365,Number(admin[3]||30)));
    await activateTelegramAiPlan(redis,target,planId,days);
    await sendTelegramAiMessageTo(chatId,`✅ Activated ${planId.toUpperCase()} for Telegram user ${target} for ${days} days.`);
    await sendTelegramAiMessageTo(target,`🎉 Your Matchday AI account is now ${planId.toUpperCase()} for ${days} days.`,{reply_markup:telegramAiMainKeyboard()}).catch(()=>{});return;
  }

  if (callbackAction) {
    const plan=getTelegramAiPlan(user);
    if(!telegramAiHasTicketCredit(user))return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${plan.dailyTickets} AI tickets and have no extra tickets left. Your daily allowance resets tomorrow, or you can buy an extra pack now.`,{reply_markup:telegramAiTicketLimitKeyboard(user)});
    let req={...(user.preferences.builder||{})};
    if(!Array.isArray(req.betTypes)||!req.betTypes.length)return sendTelegramAiMessageTo(chatId,'⚠️ Select at least one Bet Type before building.',{reply_markup:telegramAiBuilderKeyboard(user)});
    if(callbackAction==='safe'||callbackAction==='safer'){req.safe=true;req.targetOdds=1.325;req.minProbability=Math.max(80,Number(req.minProbability||0));req.maxMatchOdds=req.maxMatchOdds||1.35;}
    if(callbackAction==='rebuild'&&user.lastBuilderRequest)req={...user.lastBuilderRequest,safe:false};
    await sendTelegramAiMessageTo(chatId,`⏳ Scanning current SportyBet fixtures and applying your settings…\n${req.sport||'all'} · target ${req.safe?'SAFE 1.30–1.35':req.targetOdds+'x'} · ≥${req.minProbability}% · max ${req.maxMatchOdds||'no limit'} per match`);
    const built=await buildTelegramAiTicket(user,req).catch(e=>({error:e.message}));
    if(built.locked)return sendTelegramAiMessageTo(chatId,built.message,{reply_markup:telegramAiPlanKeyboard()});
    if(built.error)return sendTelegramAiMessageTo(chatId,`⚠️ ${built.error}`,{reply_markup:telegramAiBuilderKeyboard(user)});
    const use=await consumeTelegramAiUsage(redis,user,'ticket');user=use.user;user.lastBuilderRequest=built.request;user.lastBookingCode=built.booking?.shareCode||null;await saveTelegramAiUser(redis,user);
    return sendTelegramAiLongMessage(chatId,telegramAiTicketText(built.result,built.booking,built.request,built.plan),{reply_markup:telegramAiResultKeyboard()});
  }

  const intent=parseTelegramAiRequest(text);
  if(intent.intent==='menu'){
    const plan=getTelegramAiPlan(user);
    return sendTelegramAiMessageTo(chatId,[`🤖 Welcome${user.firstName?`, ${user.firstName}`:''} — Matchday AI`,`Plan: ${plan.name}`,'','Use 🎯 Auto Builder for the same core controls as the website, or type a request naturally.','','Examples:','• Build football 20x, max odd 1.25','• Safe ticket','• Analyze RKT1JT'].join('\n'),{reply_markup:telegramAiMainKeyboard()});
  }
  if(intent.intent==='builder')return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)});
  if(intent.intent==='help')return sendTelegramAiMessageTo(chatId,'🤖 MATCHDAY AI HELP\n\nBest option: tap 🎯 Auto Builder and choose Sport, Target Odds, Minimum Probability, Max Odd/Match, Minimum Edge, Max Games and Bet Types.\n\nYou can also type requests naturally, such as “Build football 20x, max odd 1.25, minimum 75%.”\n\nUse 🔎 Analyze Code to set the analyzer threshold and search horizon.',{reply_markup:telegramAiMainKeyboard()});
  if(intent.intent==='plans')return sendTelegramAiMessageTo(chatId,telegramAiPlansText(),{reply_markup:telegramAiPlanKeyboard()});
  if(intent.intent==='account')return sendTelegramAiMessageTo(chatId,telegramAiAccountText(user),{reply_markup:telegramAiMainKeyboard()});
  if(intent.intent==='copy'){
    const plan=getTelegramAiPlan(user);if(!plan.copyHub)return sendTelegramAiMessageTo(chatId,telegramAiUpgradeText(plan,'Copy Hub punter rankings'),{reply_markup:telegramAiPlanKeyboard()});
    if(!copyHubEnabled())return sendTelegramAiMessageTo(chatId,'🏆 Copy Hub is currently disabled by the administrator.');
    const copyStore=await readCopyHubStore(redis);
    const trackedBoard=buildLeaderboard(copyStore,{days:30,limit:100,source:'all',settledOnly:false});
    const board=buildLeaderboard(copyStore,{days:30,limit:10,source:'all',settledOnly:true});
    if(!board.length){
      const pending=trackedBoard.reduce((n,x)=>n+Number(x.pending||0),0);
      const tracked=trackedBoard.reduce((n,x)=>n+Number(x.codes||0),0);
      return sendTelegramAiMessageTo(chatId,`🏆 No settled Copy Hub rankings yet.\n\n${tracked} tracked code${tracked===1?'':'s'} · ${pending} still pending. Rankings appear after at least one tracked code settles as WON, LOST or PUSH.`,{reply_markup:telegramAiMainKeyboard()});
    }
    const lines=['🏆 MATCHDAY COPY RANKINGS — 30 DAYS',''];board.slice(0,10).forEach((x,i)=>{
      const handle=x?.punter?.username ? `@${x.punter.username}` : (x?.punter?.displayName||x?.punter?.id||'Punter');
      lines.push(`${i+1}. ${handle} — Score ${Number(x.copyScore||0).toFixed(1)} · ${Number(x.winRate||0).toFixed(1)}% win rate · ${Number(x.settled||0)} settled`);
    });return sendTelegramAiMessageTo(chatId,lines.join('\n'),{reply_markup:telegramAiMainKeyboard()});
  }
  if(intent.intent==='analyze'){
    const plan=getTelegramAiPlan(user);if(plan.dailyAnalyzes<=0)return sendTelegramAiMessageTo(chatId,telegramAiUpgradeText(plan,'SportyBet code analysis'),{reply_markup:telegramAiPlanKeyboard()});
    if(user.analyzesUsed>=plan.dailyAnalyzes)return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${plan.dailyAnalyzes} code analyses. Your daily allowance resets tomorrow.`,{reply_markup:telegramAiPlanKeyboard()});
    const cfg=user.preferences.analyzer||{minProbability:70,horizonDays:14};await sendTelegramAiMessageTo(chatId,`🔎 Analyzing ${intent.bookingCode} · keep ≥${cfg.minProbability}% · search ${cfg.horizonDays} days…`);
    try{const analysis=await analyzeTelegramAiCode(intent.bookingCode,cfg.minProbability,cfg.horizonDays,false);const use=await consumeTelegramAiUsage(redis,user,'analyze');user=use.user;user.lastAnalyzerRequest={bookingCode:intent.bookingCode,minProbability:cfg.minProbability,horizonDays:cfg.horizonDays,analyzedAt:new Date().toISOString()};await saveTelegramAiUser(redis,user);return sendTelegramAiLongMessage(chatId,telegramAiAnalysisText(analysis),{reply_markup:telegramAiAnalyzerAnalysisKeyboard(Number(analysis.unsupported||0)>0)})}catch(e){return sendTelegramAiMessageTo(chatId,`⚠️ I could not analyze that code: ${e.message}`,{reply_markup:telegramAiAnalyzerKeyboard(user)})}
  }
  if(intent.intent==='ticket'){
    const plan=getTelegramAiPlan(user);if(!telegramAiHasTicketCredit(user))return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${plan.dailyTickets} AI tickets and have no extra tickets left. Your daily allowance resets tomorrow, or you can buy an extra pack now.`,{reply_markup:telegramAiTicketLimitKeyboard(user)});
    const req=telegramAiMergeTicketRequest(user,intent);
    const built=await buildTelegramAiTicket(user,req).catch(e=>({error:e.message}));if(built.locked)return sendTelegramAiMessageTo(chatId,built.message,{reply_markup:telegramAiPlanKeyboard()});if(built.error)return sendTelegramAiMessageTo(chatId,`⚠️ ${built.error}`,{reply_markup:telegramAiMainKeyboard()});
    const use=await consumeTelegramAiUsage(redis,user,'ticket');user=use.user;user.lastBuilderRequest=built.request;user.lastBookingCode=built.booking?.shareCode||null;await saveTelegramAiUser(redis,user);return sendTelegramAiLongMessage(chatId,telegramAiTicketText(built.result,built.booking,built.request,built.plan),{reply_markup:telegramAiResultKeyboard()});
  }
  const llm=await matchdayLlmInterpret(user,text);
  if(llm?.quotaExceeded){
    await saveTelegramAiUser(redis,user);
    return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${llm.limit} conversational AI messages. Your AI chat allowance resets tomorrow. Buttons and supported direct commands are still available.`,{reply_markup:telegramAiMainKeyboard()});
  }
  if(llm){
    await saveTelegramAiUser(redis,user);
    if(llm.action==='builder') return sendTelegramAiMessageTo(chatId,llm.reply||telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)});
    if(llm.action==='plans') return sendTelegramAiMessageTo(chatId,llm.reply||telegramAiPlansText(),{reply_markup:telegramAiPlanKeyboard()});
    if(llm.action==='account') return sendTelegramAiMessageTo(chatId,`${llm.reply?llm.reply+'\n\n':''}${telegramAiAccountText(user)}`,{reply_markup:telegramAiMainKeyboard()});
    if(llm.action==='analyze'&&llm.bookingCode){
      const p=getTelegramAiPlan(user);
      if(p.dailyAnalyzes<=0)return sendTelegramAiMessageTo(chatId,telegramAiUpgradeText(p,'SportyBet code analysis'),{reply_markup:telegramAiPlanKeyboard()});
      if(user.analyzesUsed>=p.dailyAnalyzes)return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${p.dailyAnalyzes} code analyses.`,{reply_markup:telegramAiPlanKeyboard()});
      const cfg=user.preferences.analyzer||{minProbability:70,horizonDays:14};
      try{const analysis=await analyzeTelegramAiCode(llm.bookingCode,cfg.minProbability,cfg.horizonDays,false);const use=await consumeTelegramAiUsage(redis,user,'analyze');user=use.user;user.lastAnalyzerRequest={bookingCode:llm.bookingCode,minProbability:cfg.minProbability,horizonDays:cfg.horizonDays,analyzedAt:new Date().toISOString()};await saveTelegramAiUser(redis,user);return sendTelegramAiLongMessage(chatId,telegramAiAnalysisText(analysis),{reply_markup:telegramAiAnalyzerAnalysisKeyboard(Number(analysis.unsupported||0)>0)})}catch(e){return sendTelegramAiMessageTo(chatId,`⚠️ I could not analyze that code: ${e.message}`,{reply_markup:telegramAiAnalyzerKeyboard(user)})}
    }
    if(llm.action==='ticket'){
      const p=getTelegramAiPlan(user);
      if(!telegramAiHasTicketCredit(user))return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${p.dailyTickets} AI tickets and have no extra tickets left. Your daily allowance resets tomorrow, or you can buy an extra pack now.`,{reply_markup:telegramAiTicketLimitKeyboard(user)});
      const li=llmTicketIntent(llm),req=telegramAiMergeTicketRequest(user,li);
      const built=await buildTelegramAiTicket(user,req).catch(e=>({error:e.message}));
      if(built.locked)return sendTelegramAiMessageTo(chatId,built.message,{reply_markup:telegramAiPlanKeyboard()});
      if(built.error)return sendTelegramAiMessageTo(chatId,`⚠️ ${built.error}`,{reply_markup:telegramAiMainKeyboard()});
      const use=await consumeTelegramAiUsage(redis,user,'ticket');user=use.user;user.lastBuilderRequest=built.request;user.lastBookingCode=built.booking?.shareCode||null;await saveTelegramAiUser(redis,user);
      return sendTelegramAiLongMessage(chatId,telegramAiTicketText(built.result,built.booking,built.request,built.plan),{reply_markup:telegramAiResultKeyboard()});
    }
    return sendTelegramAiMessageTo(chatId,llm.reply||'How can I help with your Matchday ticket?',{reply_markup:telegramAiMainKeyboard()});
  }
  return sendTelegramAiMessageTo(chatId,'I can understand structured Matchday commands, but conversational AI is temporarily unavailable. Try “Build a football 10x ticket”.',{reply_markup:telegramAiMainKeyboard()});
}


app.post('/api/telegram/bot/webhook', express.json({ limit: '1mb' }), async (req, res) => {
  if(String(process.env.TELEGRAM_AI_ENABLED || 'true').toLowerCase()==='false') return res.status(404).json({error:'Telegram AI bot disabled'});
  const expected=String(process.env.TELEGRAM_WEBHOOK_SECRET || '');
  const supplied=String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if(!expected) return res.status(503).json({error:'TELEGRAM_WEBHOOK_SECRET is not configured'});
  if(supplied !== expected) return res.status(401).json({error:'unauthorized'});
  res.json({ok:true});
  handleTelegramAiUpdate(req.body).catch(err=>console.error('Telegram AI webhook error:',err.message));
});

app.post('/api/telegram/bot/setup', express.json(), async (req, res) => {
  try {
    if(!process.env.TELEGRAM_AI_BOT_TOKEN) return res.status(400).json({error:'Set TELEGRAM_AI_BOT_TOKEN first'});
    const secret=process.env.TELEGRAM_JOB_SECRET;
    if(!secret || req.headers['x-telegram-job-secret']!==secret) return res.status(401).json({error:'unauthorized'});
    const base=String(process.env.MATCHDAY_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/,'');
    if(!/^https:\/\//i.test(base)) return res.status(400).json({error:'Set MATCHDAY_BASE_URL to the public HTTPS Render URL first'});
    const webhookSecret=String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    if(!webhookSecret) return res.status(400).json({error:'Set TELEGRAM_WEBHOOK_SECRET first'});
    const webhook=await telegramAiRequest('setWebhook',{url:`${base}/api/telegram/bot/webhook`,secret_token:webhookSecret,allowed_updates:['message','callback_query'],drop_pending_updates:false});
    await telegramAiRequest('setMyCommands',{commands:[{command:'start',description:'Open Matchday AI'},{command:'plans',description:'View Free, Pro and Elite plans'},{command:'account',description:'View plan and daily usage'},{command:'help',description:'How to use Matchday AI'}]});
    res.json({ok:true,webhook,webhookUrl:`${base}/api/telegram/bot/webhook`});
  } catch(err){ res.status(502).json({error:'Telegram AI setup failed',detail:process.env.NODE_ENV==='production'?undefined:err.message}); }
});

app.get('/api/telegram/status', (req, res) => {
  res.json({
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_JOB_SECRET),
    targets: [10000, 1000, 20, 10, '1.30-1.35 SAFE'],
    sportScope: normalizeSportScope(process.env.TELEGRAM_SPORT_SCOPE || 'all'),
    rules: {
      regular: { minProbability: 70, positiveEdgeRequired: false, redFlagProtection: true },
      safe: { minProbability: 80, combinedOddsMin: 1.30, combinedOddsMax: 1.35, positiveEdgeRequired: false, redFlagProtection: true },
    },
    maxSelections: Math.min(40, Math.max(1, parseInt(process.env.TELEGRAM_MAX_SELECTIONS || '30', 10))),
    scheduler: 'GitHub Actions',
    aiBot: {
      enabled: String(process.env.TELEGRAM_AI_ENABLED || 'true').toLowerCase() !== 'false',
      tokenConfigured: Boolean(process.env.TELEGRAM_AI_BOT_TOKEN),
      webhookConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      plans: { free: 0, pro: 5000, elite: 20000 },
    },
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
      code: err.code || null,
      detail: String(err.message || 'Unknown Telegram picks error').slice(0, 500),
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
    if (!Array.isArray(selections) || selections.length === 0 || selections.length > 100) {
      return res.status(400).json({ error: 'selections must be an array containing 1-100 selections' });
    }
    const context = Array.isArray(req.body && req.body.telegramContext)
      ? req.body.telegramContext
      : [];
    const preferFullMarket = context.some(x => {
      const text = `${x?.marketDesc || ''} ${x?.outcomeDesc || ''} ${x?.betType || ''}`.toLowerCase();
      return text.includes('corner') || text.includes('1up') || text.includes('1 up') || text.includes('1-up');
    });
    const result = await bookBet(selections, { preferFullMarket });
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
      bookingErrorCode: err.code || null,
      detail: err.code === 'SPORTYBET_BOOKING_FAILED'
        ? err.message
        : (process.env.NODE_ENV === 'production' ? undefined : err.message),
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
