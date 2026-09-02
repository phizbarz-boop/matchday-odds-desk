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


function unwrapData(payload) {
  return payload && payload.data !== undefined ? payload.data : payload;
}

function extractUpcomingEvents(payload) {
  const root = unwrapData(payload) || {};
  const tournaments = Array.isArray(root.tournaments) ? root.tournaments : [];
  const events = [];
  for (const t of tournaments) {
    for (const e of (Array.isArray(t?.events) ? t.events : [])) {
      events.push({
        ...e,
        tournament_name: e.tournament_name ?? t.tournament_name ?? t.name ?? '',
        category: e.category ?? t.category ?? '',
      });
    }
  }
  return { events, total: Number(root.total_events || events.length) || events.length };
}

function flattenDetailedMarkets(payload, eventContext = {}) {
  const root = unwrapData(payload) || {};
  const markets = Array.isArray(root.markets)
    ? root.markets
    : Array.isArray(root?.event?.markets) ? root.event.markets
    : Array.isArray(root?.odds?.markets) ? root.odds.markets
    : [];
  const eventId = String(root.event_id ?? root.eventId ?? root?.event?.event_id ?? eventContext.event_id ?? '');
  const home = root.home_team ?? root.homeTeam ?? root?.event?.home_team ?? eventContext.home_team ?? '';
  const away = root.away_team ?? root.awayTeam ?? root?.event?.away_team ?? eventContext.away_team ?? '';
  const start = root.start_time ?? root.startTime ?? root?.event?.start_time ?? eventContext.start_time ?? null;
  const tournament = root.tournament_name ?? root.tournament ?? root?.event?.tournament_name ?? eventContext.tournament_name ?? '';
  const category = root.category ?? root?.event?.category ?? eventContext.category ?? '';
  const rows = [];
  for (const m of markets) {
    const marketId = String(m.market_id ?? m.marketId ?? m.id ?? '');
    const marketDesc = m.description ?? m.name ?? m.market_name ?? '';
    const specifier = m.specifier ?? null;
    for (const o of (Array.isArray(m.outcomes) ? m.outcomes : [])) {
      const odds = parseNumber(o.odds ?? o.price);
      if (!eventId || !marketId || odds === null) continue;
      rows.push(normalizeOutcome({
        sport:'Football',
        event_id:eventId,
        homeTeamName:home,
        awayTeamName:away,
        tournament,
        category,
        start_time:start,
        marketId,
        marketDesc,
        outcomeId:o.id ?? o.outcome_id,
        outcomeDesc:o.description ?? o.name ?? o.outcome_name,
        odds,
        specifier: o.specifier ?? specifier,
      }, 'Football'));
    }
  }
  return rows.filter(r => r.eventId && r.home && r.away && r.outcomeId && r.odds !== null);
}

function isDetailedMarketRow(row, kind) {
  const text = `${row.marketDesc || ''} ${row.outcomeDesc || ''} ${row.specifier || ''}`.toLowerCase();

  if (kind === 'oneup') {
    // SportyBet commonly labels this as "1X2 - 1UP", "1UP", or wording such as
    // "team to lead by 1 goal". Only accept explicit 1UP/lead-by-one markets.
    return /\b1\s*[- ]?\s*up\b|\b1up\b|1x2\s*[-–:]?\s*1\s*[- ]?\s*up|lead\s+by\s+(?:1|one)\s+goal|(?:team\s+)?to\s+lead\s+(?:by\s+)?(?:1|one)/.test(text);
  }

  if (!/corner/.test(text)) return false;
  const firstHalf = /(1st|first)\s*half|1h/.test(text);
  const teamish = /team|home|away/.test(text);
  if (kind === 'first_half_team_corners') return firstHalf && teamish;
  if (kind === 'corners') return !firstHalf;
  return false;
}

// The original SportyBet NG "football markets" Parse endpoint can omit some markets
// such as corners and 1UP. For those we fall back to the user's subscribed full-market
// SportyBet API: get_upcoming_events -> get_event_odds. Results are cached by server.js,
// so this is not polled on every click.
async function getDetailedFootballMarket(kind, { hours = 96, maxPages = null } = {}) {
  const pageSize = Math.max(1, Math.min(100, parseInt(process.env.SPORTYBET_DETAIL_PAGE_SIZE || '100', 10)));
  // Scan enough pages to cover the same horizon as the normal market loader.
  const pageLimit = Math.max(1, Math.min(20, parseInt(maxPages || process.env.SPORTYBET_DETAIL_MAX_PAGES || '6', 10)));
  const fallbackMaxEvents = Math.max(0, Math.min(100, parseInt(process.env.SPORTYBET_DETAIL_EVENT_ODDS_FALLBACK || '20', 10)));
  const cutoff = Date.now() + Math.max(1, Number(hours || 96)) * 3600 * 1000;
  const rows = [];
  const fallbackEvents = [];
  let scannedEvents = 0;
  let totalKnown = Infinity;

  // get_upcoming_events itself contains market arrays. Scan those first. This is much
  // cheaper and much broader than calling get_event_odds for an arbitrary first 60 games.
  for (let page = 1; page <= pageLimit && scannedEvents < totalKnown; page++) {
    const payload = await parseFetch('get_upcoming_events', {
      params: { page, sport:'football', page_size:pageSize, today_only:false },
      base: BOOKING_BASE,
    });

    const parsed = extractUpcomingEvents(payload);
    totalKnown = Number(parsed.total || totalKnown);
    if (!parsed.events.length) break;

    for (const e of parsed.events) {
      scannedEvents++;
      const t = Number(e.start_time ?? e.startTime ?? 0);
      const ms = t && t < 1e12 ? t * 1000 : t;
      if (ms && ms > cutoff) continue;

      const embedded = flattenDetailedMarkets(e, e).filter(r => isDetailedMarketRow(r, kind));
      if (embedded.length) rows.push(...embedded);
      else if (fallbackEvents.length < fallbackMaxEvents) fallbackEvents.push(e);
    }

    if (parsed.events.length < pageSize) break;
  }

  // Some SportyBet responses expose only a subset of markets in the event list.
  // If the scan found nothing (or only very little), inspect a bounded number of events
  // with get_event_odds. This is a fallback, not the primary path.
  if (rows.length === 0 && fallbackMaxEvents > 0) {
    for (const e of fallbackEvents.slice(0, fallbackMaxEvents)) {
      const eventId = String(e.event_id ?? e.eventId ?? '');
      if (!eventId) continue;
      try {
        const payload = await parseFetch('get_event_odds', {
          params: { event_id:eventId },
          base: BOOKING_BASE,
        });
        rows.push(...flattenDetailedMarkets(payload, e).filter(r => isDetailedMarketRow(r, kind)));
      } catch (err) {
        console.warn(`SportyBet detailed odds ${eventId}: ${err.message}`);
      }
    }
  }

  // De-duplicate exact selectable outcomes.
  const dedup = new Map();
  for (const r of rows) {
    const key = [r.eventId,r.marketId,r.outcomeId,r.specifier||''].join('|');
    if (!dedup.has(key)) dedup.set(key,r);
  }
  const finalRows = [...dedup.values()];

  return {
    sport:'football',
    market:kind,
    source:'SportyBet full-market API',
    fetchedAt:new Date().toISOString(),
    scannedEvents,
    totalReturned:finalRows.length,
    rows:finalRows,
  };
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
  // As of Sep 2026 the managed NG football-markets endpoint documents goals/handicaps/
  // BTTS etc. but not corners. If it returns zero corner rows, use the subscribed
  // full-market SportyBet endpoint which exposes every market per event.
  if (kind === 'corners' || kind === 'first_half_team_corners' || kind === 'oneup') {
    // The generic substring endpoint can occasionally return unrelated rows. Keep only
    // rows whose market text actually describes the requested special market.
    normalized = normalized.filter(r => isDetailedMarketRow(r, kind));
    if (normalized.length === 0) {
      const detailed = await getDetailedFootballMarket(kind, { hours, maxPages });
      normalized = detailed.rows || [];
    }
  }
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

module.exports = { FOOTBALL_MARKETS, SPORT_CONFIG, getFootballMarket, getSportMarket, getBooking, bookBet, normalizeOutcome, flattenDetailedMarkets, isDetailedMarketRow };
