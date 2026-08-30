const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1); // Render forwards the real client IP.
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'predictions.json');
const { getFootballMarket, getSportMarket, bookBet, SPORT_CONFIG } = require('./lib/sportybet');
const { buildCandidates, selectAutoBet } = require('./lib/autoPicker');

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
// Supported values: 1x2, gg, ou. Results are cached (Redis when available).
app.get('/api/sportybet/odds', async (req, res) => {
  try {
    const kind = String(req.query.market || '1x2').toLowerCase();
    if (!['1x2', 'gg', 'ou'].includes(kind)) {
      return res.status(400).json({ error: 'market must be one of: 1x2, gg, ou' });
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

// Automatic slip builder. It combines the football model/H2H probabilities with
// SportyBet prices and the strongest no-vig basketball/hockey winner prices.
// The response contains selections only; booking-code creation still uses /book.
app.post('/api/sportybet/auto-pick', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const targetOdds = Math.min(500, Math.max(1.05, Number(body.targetOdds) || 5));
    const minProbability = Math.min(95, Math.max(0, Number(body.minProbability) || 55));
    const maxSelections = Math.min(20, Math.max(1, parseInt(body.maxSelections || '8', 10)));
    const leagues = Array.isArray(body.leagues) ? body.leagues.map(String) : null;

    const [predictions, f1x2, fgg, fou, basketballWinner, hockeyWinner] = await Promise.all([
      loadPredictions(),
      loadSportyBetMarket('1x2', 'football'),
      loadSportyBetMarket('gg', 'football'),
      loadSportyBetMarket('ou', 'football'),
      loadSportyBetMarket('winner', 'basketball'),
      loadSportyBetMarket('winner', 'hockey'),
    ]);

    const candidates = buildCandidates({
      predictions,
      footballMarkets: { '1x2': f1x2, gg: fgg, ou: fou },
      basketballWinner,
      hockeyWinner,
      minProbability,
      leagues,
    });

    const result = selectAutoBet(candidates, { targetOdds, maxSelections });
    if (!result.selections.length) {
      return res.status(404).json({
        error: 'No eligible SportyBet selections matched the requested minimum probability',
        targetOdds,
        minProbability,
        candidateCount: candidates.length,
      });
    }

    res.json({
      ...result,
      minProbability,
      maxSelections,
      generatedAt: new Date().toISOString(),
      note: 'Football probability = Poisson + H2H. Basketball/hockey probability = no-vig SportyBet market probability.',
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
    res.json(result);
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
