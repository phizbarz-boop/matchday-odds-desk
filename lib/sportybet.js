// Server-side client for the Parse.bot SportyBet Nigeria API.
// Keep PARSE_API_KEY on the server only; never expose it to public/index.html.

const SCRAPER_ID = process.env.PARSE_SCRAPER_ID || '8e652912-d760-4522-85ce-071e539a9c12';
const BASE = `https://api.parse.bot/scraper/${SCRAPER_ID}`;
const BOOKING_SCRAPER_ID = process.env.PARSE_BOOKING_SCRAPER_ID || '8ffd9f0c-6174-43af-80dc-4898f47f074b';
const BOOKING_BASE = `https://api.parse.bot/scraper/${BOOKING_SCRAPER_ID}`;

const FOOTBALL_MARKETS = {
  '1x2': { query: '1X2', marketId: '1' },
  gg:    { query: 'GG/NG', marketId: '29' },
  dc:    { query: 'Double Chance', marketId: '10' },
  dnb:   { query: 'Draw No Bet', marketId: '11' },
  ou15:  { query: 'Over/Under', marketId: '18', specifier: 'total=1.5' },
  ou45:  { query: 'Over/Under', marketId: '18', specifier: 'total=4.5' },
  ah:    { query: 'Asian Handicap', marketId: '16', allowedHandicaps: [0, 0.25, -0.25] },
  // SportyBet exposes this as a dedicated "1X2 - 1UP"/1UP market on eligible fixtures.
  // Do not hard-code a marketId: use the IDs returned by SportyBet so booking stays valid.
  oneup: { query: '1UP', marketId: null },
  // Total-corners market. The Parse scraper returns the real SportyBet market/outcome IDs,
  // so booking remains compatible even if SportyBet changes an internal market id.
  corners: { query: process.env.SPORTYBET_CORNERS_MARKET_QUERY || 'Corners', marketId: null },
  // First-half team corner totals. IDs are deliberately discovered from SportyBet.
  // Query can be overridden if Parse/SportyBet uses a different market label.
  first_half_team_corners: { query: process.env.SPORTYBET_1H_TEAM_CORNERS_MARKET_QUERY || '1st Half Team Corners', marketId: null },
};

const SPORT_CONFIG = {
  basketball: {
    endpoint: 'get_prematch_basketball_events',
    defaultMarket: 'winner',
    markets: {
      winner: { query: 'Winner', marketId: '219', label: 'Winner incl. OT' },
      handicap: { query: 'Handicap', marketId: '223', label: 'Handicap incl. OT' },
      totals: { query: 'Over/Under', marketId: '225', label: 'Over/Under incl. OT' },
    },
  },
  hockey: {
    endpoint: 'get_prematch_ice_hockey_events',
    defaultMarket: 'winner',
    markets: {
      winner: { query: '1X2', marketId: '1', label: 'Match Winner' },
      handicap: { query: 'Handicap', marketId: null, label: 'Puck Line / Handicap' },
      totals: { query: 'Over/Under', marketId: null, label: 'Over/Under Goals' },
    },
  },
};

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractRows(payload) {
  const root = payload && payload.data !== undefined ? payload.data : payload;
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== 'object') return [];
  for (const key of ['outcomes', 'events', 'results', 'items', 'rows']) {
    if (Array.isArray(root[key])) return root[key];
  }
  return [];
}

function extractTotal(payload) {
  const root = payload && payload.data !== undefined ? payload.data : payload;
  if (!root || typeof root !== 'object') return null;
  for (const key of ['totalOutcomes', 'totalEvents', 'total', 'count']) {
    const n = parseNumber(root[key]);
    if (n !== null) return n;
  }
  return null;
}

async function parseFetch(endpoint, { method = 'GET', params = {}, body, base = BASE } = {}) {
  const apiKey = process.env.PARSE_API_KEY;
  if (!apiKey) {
    const err = new Error('Missing PARSE_API_KEY environment variable');
    err.code = 'PARSE_API_KEY_MISSING';
    throw err;
  }

  const url = new URL(`${base}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { 'X-API-Key': apiKey };
  const options = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Parse.bot ${endpoint} -> ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  if (payload && payload.status && payload.status !== 'success' && payload.error) {
    const err = new Error(`Parse.bot ${endpoint}: ${payload.error}`);
    err.payload = payload;
    throw err;
  }
  return payload;
}

function normalizeOutcome(row, sport = null) {
  const kickoffRaw = row.estimateStartTime ?? row.kickoffUtc ?? row.startTime ?? row.start_time;
  const kickoffNum = parseNumber(kickoffRaw);
  let kickoffUtc = null;
  if (kickoffNum !== null) {
    kickoffUtc = new Date(kickoffNum < 1e12 ? kickoffNum * 1000 : kickoffNum).toISOString();
  } else if (kickoffRaw) {
    const d = new Date(kickoffRaw);
    if (!Number.isNaN(d.getTime())) kickoffUtc = d.toISOString();
  }

  return {
    sport: row.sport ?? sport ?? '',
    eventId: String(row.eventId ?? row.event_id ?? ''),
    home: row.homeTeamName ?? row.homeTeam ?? row.home ?? '',
    away: row.awayTeamName ?? row.awayTeam ?? row.away ?? '',
    tournament: row.tournament ?? row.tournamentName ?? '',
    category: row.category ?? '',
    kickoffUtc,
    marketId: String(row.marketId ?? row.market_id ?? ''),
    marketDesc: row.marketDesc ?? row.marketName ?? row.market ?? '',
    outcomeId: String(row.outcomeId ?? row.outcome_id ?? ''),
    outcomeDesc: row.outcomeDesc ?? row.outcomeName ?? row.outcome ?? '',
    odds: parseNumber(row.odds),
    specifier: row.specifier ?? null,
  };
}

async function pagedMarket(endpoint, { market, marketId = null, specifier = null, hours = 96, sport = null, maxPages = null } = {}) {
  const pageSize = Math.max(1, Math.min(100, parseInt(process.env.SPORTYBET_PAGE_SIZE || '100', 10)));
  const defaultMaxPages = Math.max(1, Math.min(20, parseInt(process.env.SPORTYBET_MAX_PAGES || '5', 10)));
  const pageLimit = Math.max(1, Math.min(20, parseInt(maxPages || defaultMaxPages, 10)));
  const collected = [];
  let total = null;

  for (let page = 1; page <= pageLimit; page++) {
    const payload = await parseFetch(endpoint, {
      params: { page, page_size: pageSize, market, hours },
    });
    const rows = extractRows(payload);
    if (total === null) total = extractTotal(payload);
    collected.push(...rows);
    if (rows.length < pageSize) break;
    if (total !== null && collected.length >= total) break;
  }

  return collected
    .map(r => normalizeOutcome(r, sport))
    .filter(r => r.eventId && r.home && r.away && r.outcomeId && r.odds !== null)
    .filter(r => marketId ? r.marketId === String(marketId) : true)
    .filter(r => specifier ? String(r.specifier || '').toLowerCase() === String(specifier).toLowerCase() : true);
}

async function getFootballMarket(kind, { hours = 96, maxPages = null } = {}) {
  const cfg = FOOTBALL_MARKETS[kind];
  if (!cfg) throw new Error(`Unsupported SportyBet football market: ${kind}`);
  let normalized = await pagedMarket('get_prematch_football_markets', {
    market: cfg.query,
    marketId: cfg.marketId,
    specifier: cfg.specifier,
    hours,
    sport: 'Football',
    maxPages,
  });
  if (kind === 'ah') {
    normalized = normalized.filter(r => {
      const m = String(r.specifier || '').match(/hcp\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
      if (!m) return false;
      const n = Number(m[1]);
      return [0, 0.25, -0.25].some(v => Math.abs(n - v) < 0.001);
    });
  }
  return {
    sport: 'football',
    market: kind,
    fetchedAt: new Date().toISOString(),
    totalReturned: normalized.length,
    rows: normalized,
  };
}

async function getSportMarket(sport, kind, { hours = 96, maxPages = null } = {}) {
  const cfg = SPORT_CONFIG[sport];
  if (!cfg) throw new Error(`Unsupported SportyBet sport: ${sport}`);
  const marketCfg = cfg.markets[kind || cfg.defaultMarket];
  if (!marketCfg) throw new Error(`Unsupported ${sport} market: ${kind}`);

  const rows = await pagedMarket(cfg.endpoint, {
    market: marketCfg.query,
    marketId: marketCfg.marketId,
    hours,
    sport: sport === 'hockey' ? 'Ice Hockey' : 'Basketball',
    maxPages,
  });

  return {
    sport,
    market: kind || cfg.defaultMarket,
    marketLabel: marketCfg.label,
    fetchedAt: new Date().toISOString(),
    totalReturned: rows.length,
    rows,
  };
}


async function getBooking(bookingCode) {
  const code = String(bookingCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,24}$/.test(code)) {
    const err = new Error('Invalid SportyBet booking code');
    err.code = 'INVALID_BOOKING_CODE';
    throw err;
  }
  const payload = await parseFetch('get_booking', {
    params: { booking_code: code },
    base: BOOKING_BASE,
  });
  return payload && payload.data !== undefined ? payload.data : payload;
}

async function bookBet(selections) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error('selections must be a non-empty array');
  }

  const cleaned = selections.map(s => ({
    eventId: String(s.eventId || ''),
    marketId: String(s.marketId || ''),
    outcomeId: String(s.outcomeId || ''),
    ...(s.specifier ? { specifier: String(s.specifier) } : {}),
  }));

  if (cleaned.some(s => !s.eventId || !s.marketId || !s.outcomeId)) {
    throw new Error('Each selection requires eventId, marketId and outcomeId');
  }

  const payload = await parseFetch('book_bet', {
    method: 'POST',
    body: { selections: JSON.stringify(cleaned) },
  });

  return payload && payload.data !== undefined ? payload.data : payload;
}

module.exports = { FOOTBALL_MARKETS, SPORT_CONFIG, getFootballMarket, getSportMarket, getBooking, bookBet, normalizeOutcome };
