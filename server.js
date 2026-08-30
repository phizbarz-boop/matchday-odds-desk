const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // Render forwards the real client IP.
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'predictions.json');
const { getFootballMarket, getSportMarket, bookBet, SPORT_CONFIG } = require('./lib/sportybet');
const { buildCandidates, selectAutoBet } = require('./lib/autoPicker');
const { sendTelegramMessage } = require('./lib/telegram');

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

async function loadSportyBetMarket(kind, sport = 'football') {
  const ttlSeconds = Math.max(60, parseInt(process.env.SPORTYBET_CACHE_SECONDS || '43200', 10));
  const cacheKey = `sportybet:${sport}:${kind}:latest`;
  const client = await getRedis();

  if (client) {
    const raw = await client.get(cacheKey);
    if (raw) return JSON.parse(raw);
  } else {
    const hit = sportyMemoryCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.payload;
  }

  const hours = Math.max(1, parseInt(process.env.SPORTYBET_HOURS || String((parseInt(process.env.DAYS_AHEAD || '4', 10) + 1) * 24), 10));
  const payload = sport === 'football'
    ? await getFootballMarket(kind, { hours })
    : await getSportMarket(sport, kind, { hours });

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


// Live-ish SportyBet price layer. The Parse API key never reaches the browser.
// Supported football values: 1x2, gg, dc, dnb, ou15, ou45, ah. O/U 2.5 is intentionally not used by the Auto Builder.
app.get('/api/sportybet/odds', async (req, res) => {
  try {
    const kind = String(req.query.market || '1x2').toLowerCase();
    if (!['1x2', 'gg', 'dc', 'dnb', 'ou15', 'ou45', 'ah'].includes(kind)) {
      return res.status(400).json({ error: 'market must be one of: 1x2, gg, dc, dnb, ou15, ou45, ah' });
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

async function loadAutoCandidates({ sportScope = 'all', minProbability = 55, minEdge = 0, leagues = null, betTypes = null } = {}) {
  const scope = normalizeSportScope(sportScope);
  const wantsFootball = scope === 'all' || scope === 'football';
  const wantsBasketball = scope === 'all' || scope === 'basketball';
  const wantsHockey = scope === 'all' || scope === 'hockey';

  const [predictions, f1x2, fgg, fdc, fdnb, fou15, fou45, fah, basketballWinner, hockeyWinner] = await Promise.all([
    wantsFootball ? loadPredictions() : Promise.resolve({ matches: [] }),
    wantsFootball ? loadSportyBetMarket('1x2', 'football') : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('gg', 'football') : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('dc', 'football') : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('dnb', 'football') : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('ou15', 'football') : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('ou45', 'football') : Promise.resolve({ rows: [] }),
    wantsFootball ? loadSportyBetMarket('ah', 'football') : Promise.resolve({ rows: [] }),
    wantsBasketball ? loadSportyBetMarket('winner', 'basketball') : Promise.resolve({ rows: [] }),
    wantsHockey ? loadSportyBetMarket('winner', 'hockey') : Promise.resolve({ rows: [] }),
  ]);

  return buildCandidates({
    predictions,
    footballMarkets: { '1x2': f1x2, gg: fgg, dc: fdc, dnb: fdnb, ou15: fou15, ou45: fou45, ah: fah },
    basketballWinner,
    hockeyWinner,
    minProbability,
    minEdge,
    leagues,
    sportScope: scope,
    betTypes,
  });
}

app.post('/api/sportybet/auto-pick', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const targetOdds = Math.min(2000, Math.max(1.05, Number(body.targetOdds) || 5));
    const minProbability = Math.min(95, Math.max(0, Number(body.minProbability) || 55));
    const maxSelections = Math.min(30, Math.max(1, parseInt(body.maxSelections || '8', 10)));
    const minEdge = Math.min(50, Math.max(-25, Number(body.minEdge) || 0));
    const leagues = Array.isArray(body.leagues) ? body.leagues.map(String) : null;
    const sportScope = normalizeSportScope(body.sportScope);
    const betTypes = Array.isArray(body.betTypes) ? body.betTypes.map(String) : null;

    const candidates = await loadAutoCandidates({ sportScope, minProbability, minEdge, leagues, betTypes });
    const result = selectAutoBet(candidates, { targetOdds, maxSelections });
    if (!result.selections.length) {
      return res.status(404).json({
        error: 'No eligible SportyBet selections matched the requested sport and minimum probability',
        targetOdds,
        minProbability,
        sportScope,
        candidateCount: candidates.length,
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
      note: 'Value engine: football uses 1X2, GG/NG, Double Chance, Draw No Bet, Over 1.5, Under 4.5 and Asian Handicap +0/+0.25/-0.25. O/U 2.5 is excluded. DNB/AH use settlement-aware fair odds and EV; basketball/hockey remain no-vig market estimates.',
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
  const minProbability = Math.min(95, Math.max(0, Number(process.env.TELEGRAM_MIN_PROBABILITY || 55)));
  const maxSelections = Math.min(30, Math.max(1, parseInt(process.env.TELEGRAM_MAX_SELECTIONS || '30', 10)));
  const minEdge = Math.min(50, Math.max(-25, Number(process.env.TELEGRAM_MIN_EDGE || 0)));
  const leagues = process.env.TELEGRAM_FOOTBALL_LEAGUES
    ? process.env.TELEGRAM_FOOTBALL_LEAGUES.split(',').map(x => x.trim()).filter(Boolean)
    : null;

  const candidates = await loadAutoCandidates({ sportScope, minProbability, minEdge, leagues });
  if (!candidates.length) throw new Error('No eligible candidates are available for the Telegram picks job');

  await sendTelegramMessage([
    '🤖 MATCHDAY ODDS DESK — AUTO PICKS',
    `Scope: ${sportScope.toUpperCase()}`,
    `Targets: ${targets.join(', ')}`,
    `Minimum probability: ${minProbability}%`,
    `Minimum football edge: ${minEdge} pts`,
    `Eligible candidates scanned: ${candidates.length}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'Model probabilities are estimates, not guarantees.',
  ].join('\n'));

  const output = [];
  for (const target of targets) {
    const result = selectAutoBet(candidates, {
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

  return { sportScope, minProbability, minEdge, maxSelections, candidateCount: candidates.length, results: output };
}

app.get('/api/telegram/status', (req, res) => {
  res.json({
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_JOB_SECRET),
    targets: parseTargetList(process.env.TELEGRAM_TARGET_ODDS),
    sportScope: normalizeSportScope(process.env.TELEGRAM_SPORT_SCOPE || 'all'),
    minProbability: Math.min(95, Math.max(0, Number(process.env.TELEGRAM_MIN_PROBABILITY || 55))),
    minEdge: Math.min(50, Math.max(-25, Number(process.env.TELEGRAM_MIN_EDGE || 0))),
    maxSelections: Math.min(30, Math.max(1, parseInt(process.env.TELEGRAM_MAX_SELECTIONS || '30', 10))),
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
