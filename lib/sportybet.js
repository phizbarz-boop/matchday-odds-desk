// Server-side client for SportyBet Nigeria, talking DIRECTLY to SportyBet.
//
// Parse.bot has been removed entirely. Fixtures/markets/odds are scraped from
// SportyBet's own public web endpoints, and booking codes are created through
// the logged-in dummy account session managed by lib/sportybetDirect.js
// (automatic login, persistent cookie jar, keep-alive, silent re-login).
//
// The exported interface (getFootballMarket / getSportMarket / getBooking /
// bookBet / ...) is unchanged, so server.js, the jobs and the other libs do
// not care where the rows come from.

const direct = require('./sportybetDirect');
const { isTeamTotalSelection } = require('./teamGoalMarket');

// In-memory upstream caches ---------------------------------------------------
// Reading SportyBet directly costs no credits, but the Auto Builder, Telegram
// and the Analyzer ask for many markets built from the same fixture list, so
// prematch pages and per-event market payloads are still cached briefly to
// keep request rates polite and pages fast.
const responseCache = new Map();
const inFlight = new Map();
const upstreamUsage = new Map();

function cachePolicy(kind) {
  // Complete per-event market payloads are shared by Corners, 1H Corners, 1UP
  // and the four team-goal markets.
  if (kind === 'eventDetail') return Math.max(300, Number(process.env.SPORTYBET_EVENT_ODDS_CACHE_SECONDS || 43200));
  if (kind === 'prematch') return Math.max(60, Number(process.env.SPORTYBET_UPCOMING_CACHE_SECONDS || 900));
  // Settlement state can change after matches finish; keep booking lookups short.
  if (kind === 'booking') return Math.max(60, Number(process.env.SPORTYBET_BOOKING_LOOKUP_CACHE_SECONDS || 600));
  return 0;
}

function usageLog(kind, state) {
  const row = upstreamUsage.get(kind) || { upstream: 0, cacheHit: 0, shared: 0 };
  row[state] = (row[state] || 0) + 1;
  upstreamUsage.set(kind, row);
  const total = [...upstreamUsage.values()].reduce((n, x) => n + (x.upstream || 0), 0);
  console.log(`[SportyBet direct] ${kind} ${state} | endpoint upstream=${row.upstream || 0} cacheHit=${row.cacheHit || 0} shared=${row.shared || 0} | process upstream total=${total}`);
}

async function cachedFetch(kind, cacheKey, fetcher) {
  const ttl = cachePolicy(kind);
  const now = Date.now();
  if (ttl > 0) {
    const hit = responseCache.get(cacheKey);
    if (hit && hit.expiresAt > now) {
      usageLog(kind, 'cacheHit');
      return hit.payload;
    }
    if (hit) responseCache.delete(cacheKey);
    const pending = inFlight.get(cacheKey);
    if (pending) {
      usageLog(kind, 'shared');
      return pending;
    }
  }
  const promise = (async () => {
    usageLog(kind, 'upstream');
    return fetcher();
  })();
  if (ttl <= 0) return promise;
  inFlight.set(cacheKey, promise);
  try {
    const payload = await promise;
    responseCache.set(cacheKey, { payload, expiresAt: Date.now() + ttl * 1000 });
    if (responseCache.size > 400) responseCache.delete(responseCache.keys().next().value);
    return payload;
  } finally {
    if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
  }
}

// ---------------------------------------------------------------------------
// Market configuration (unchanged semantics; IDs still come from SportyBet
// responses so booking stays valid when SportyBet changes internal ids)
// ---------------------------------------------------------------------------

const TEAM_GOAL_KINDS = Object.freeze(['home_ou05', 'away_ou05', 'home_ou45', 'away_ou45']);
const TEAM_GOAL_SPECS = Object.freeze({
  home_ou05: ['home', '0.5', 'over'],
  away_ou05: ['away', '0.5', 'over'],
  home_ou45: ['home', '4.5', 'under'],
  away_ou45: ['away', '4.5', 'under'],
});
const teamGoalBundleCache = new Map();
const teamGoalBundleInFlight = new Map();

const FOOTBALL_MARKETS = {
  '1x2': { query: '1X2', marketId: '1' },
  gg:    { query: 'GG/NG', marketId: '29' },
  dc:    { query: 'Double Chance', marketId: '10' },
  dnb:   { query: 'Draw No Bet', marketId: '11' },
  ou05:  { query: 'Over/Under', marketId: '18', specifier: 'total=0.5' },
  home_ou05: { query: 'Home Total', marketId: null, specifier: null },
  away_ou05: { query: 'Away Total', marketId: null, specifier: null },
  home_ou45: { query: 'Home Total', marketId: null, specifier: null },
  away_ou45: { query: 'Away Total', marketId: null, specifier: null },
  ou15:  { query: 'Over/Under', marketId: '18', specifier: 'total=1.5' },
  ou45:  { query: 'Over/Under', marketId: '18', specifier: 'total=4.5' },
  ah:    { query: 'Asian Handicap', marketId: '16', allowedHandicaps: [0, 0.25, -0.25] },
  // SportyBet exposes this as a dedicated "1X2 - 1UP"/1UP market on eligible fixtures.
  // Do not hard-code a marketId: use the IDs returned by SportyBet so booking stays valid.
  oneup: { query: '1UP', marketId: null },
  corners: { query: process.env.SPORTYBET_CORNERS_MARKET_QUERY || 'Corners', marketId: null },
  first_half_team_corners: { query: process.env.SPORTYBET_1H_TEAM_CORNERS_MARKET_QUERY || '1st Half Team Corners', marketId: null },
};

const SPECIAL_FOOTBALL_KINDS = new Set(['corners', 'first_half_team_corners', 'oneup', ...TEAM_GOAL_KINDS]);

// SportyBet's internal sport ids (sr:sport:N). Override via env if SportyBet
// renumbers: SPORTYBET_SPORT_ID_FOOTBALL / _BASKETBALL / _HOCKEY / _TENNIS /
// _VOLLEYBALL / _HANDBALL.
const SPORT_IDS = {
  football: String(process.env.SPORTYBET_SPORT_ID_FOOTBALL || 'sr:sport:1'),
  basketball: String(process.env.SPORTYBET_SPORT_ID_BASKETBALL || 'sr:sport:2'),
  hockey: String(process.env.SPORTYBET_SPORT_ID_HOCKEY || 'sr:sport:4'),
  tennis: String(process.env.SPORTYBET_SPORT_ID_TENNIS || 'sr:sport:5'),
  handball: String(process.env.SPORTYBET_SPORT_ID_HANDBALL || 'sr:sport:6'),
  volleyball: String(process.env.SPORTYBET_SPORT_ID_VOLLEYBALL || 'sr:sport:23'),
};

const SPORT_CONFIG = {
  basketball: {
    defaultMarket: 'winner',
    markets: {
      winner: { query: 'Winner', marketId: '219', label: 'Winner incl. OT' },
      handicap: { query: 'Handicap', marketId: '223', label: 'Handicap incl. OT' },
      totals: { query: 'Over/Under', marketId: '225', label: 'Over/Under incl. OT' },
    },
  },
  hockey: {
    defaultMarket: 'winner',
    markets: {
      winner: { query: '1X2', marketId: '1', label: 'Match Winner' },
      handicap: { query: 'Handicap', marketId: null, label: 'Puck Line / Handicap' },
      totals: { query: 'Over/Under', marketId: null, label: 'Over/Under Goals' },
    },
  },
  // IDs are discovered from the live SportyBet response (marketId: null) so a
  // SportyBet-side renumbering never breaks booking.
  tennis: {
    defaultMarket: 'winner',
    markets: {
      winner: { query: 'Winner', marketId: null, label: 'Match Winner' },
      handicap: { query: 'Handicap', marketId: null, label: 'Set/Game Handicap' },
      totals: { query: 'Over/Under', marketId: null, label: 'Total Games' },
    },
  },
  handball: {
    defaultMarket: 'winner',
    markets: {
      winner: { query: '1X2', marketId: null, label: 'Match Winner' },
      totals: { query: 'Over/Under', marketId: null, label: 'Total Goals' },
      handicap: { query: 'Handicap', marketId: null, label: 'Handicap' },
    },
  },
  volleyball: {
    defaultMarket: 'winner',
    markets: {
      winner: { query: 'Winner', marketId: null, label: 'Match Winner' },
      totals: { query: 'Over/Under', marketId: null, label: 'Total Points' },
      handicap: { query: 'Handicap', marketId: null, label: 'Set/Point Handicap' },
    },
  },
};

// Sport labels used when normalizing rows per sport.
const SPORT_LABELS = {
  football: 'Football',
  basketball: 'Basketball',
  hockey: 'Ice Hockey',
  tennis: 'Tennis',
  handball: 'Handball',
  volleyball: 'Volleyball',
};

// ---------------------------------------------------------------------------
// Response normalization (shape-defensive; unchanged contract with server.js)
// ---------------------------------------------------------------------------

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unwrapData(payload) {
  return payload && payload.data !== undefined ? payload.data : payload;
}

function extractRows(payload) {
  const root = unwrapData(payload);
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== 'object') return [];
  for (const key of ['outcomes', 'events', 'results', 'items', 'rows']) {
    if (Array.isArray(root[key])) return root[key];
  }
  return [];
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
        category: e.category ?? t.category ?? (t.category && t.category.name) ?? '',
      });
    }
  }
  if (!events.length && Array.isArray(root)) return { events: root, total: root.length };
  if (!events.length && Array.isArray(root.events)) return { events: root.events, total: Number(root.total || root.total_events || root.events.length) || root.events.length };
  if (!events.length) {
    // Shape-defensive fallback: SportyBet has changed its envelope before. Walk
    // the payload and adopt the first array whose items look like events.
    const deep = deepFindEvents(root);
    if (deep) return { events: deep, total: deep.length };
  }
  return { events, total: Number(root.total_events || root.total || events.length) || events.length };
}

function looksLikeEvent(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const hasId = x.eventId != null || x.event_id != null;
  const home = x.homeTeamName ?? x.home_team ?? x.homeTeam ?? x.home;
  const away = x.awayTeamName ?? x.away_team ?? x.awayTeam ?? x.away;
  return !!(hasId && home && away);
}

function deepFindEvents(node, depth = 0, seen = new Set()) {
  if (depth > 6 || !node || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    if (node.length && node.filter(looksLikeEvent).length * 2 >= node.length) return node;
    for (const item of node.slice(0, 5)) {
      const found = deepFindEvents(item, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  for (const value of Object.values(node)) {
    const found = deepFindEvents(value, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function normalizeOutcome(row, sport = null) {
  const kickoffRaw =
    row.estimateStartTime ??
    row.kickoffUtc ??
    row.startTime ??
    row.start_time ??
    row.kickoffTime ??
    row.kickoff_time ??
    row.eventStartTime ??
    row.event_start_time ??
    row.eventTime ??
    row.event_time ??
    row.startDate ??
    row.start_date ??
    row.eventDate ??
    row.event_date ??
    row.matchTime ??
    row.match_time ??
    row.commenceTime ??
    row.commence_time ??
    row.timestamp ??
    row?.event?.estimateStartTime ??
    row?.event?.startTime ??
    row?.event?.start_time ??
    row?.event?.kickoffTime ??
    row?.event?.kickoff_time ??
    row?.event?.eventTime ??
    row?.event?.event_time ??
    null;
  const kickoffNum = parseNumber(kickoffRaw);
  let kickoffUtc = null;
  if (kickoffNum !== null) {
    kickoffUtc = new Date(kickoffNum < 1e12 ? kickoffNum * 1000 : kickoffNum).toISOString();
  } else if (kickoffRaw) {
    const d = new Date(kickoffRaw);
    if (!Number.isNaN(d.getTime())) kickoffUtc = d.toISOString();
  }

  const eventObj = row.event && typeof row.event === 'object' ? row.event : {};
  return {
    sport: row.sport ?? sport ?? '',
    eventId: String(row.eventId ?? row.event_id ?? eventObj.eventId ?? eventObj.event_id ?? ''),
    home: row.homeTeamName ?? row.homeTeam ?? row.home_team ?? row.home ?? eventObj.homeTeamName ?? eventObj.home_team ?? '',
    away: row.awayTeamName ?? row.awayTeam ?? row.away_team ?? row.away ?? eventObj.awayTeamName ?? eventObj.away_team ?? '',
    tournament: row.tournament ?? row.tournamentName ?? row.tournament_name ?? (row.tournament && row.tournament.name) ?? '',
    category: row.category ?? (row.category && row.category.name) ?? '',
    kickoffUtc,
    marketId: String(row.marketId ?? row.market_id ?? ''),
    marketDesc: row.marketDesc ?? row.marketName ?? row.market ?? row.desc ?? '',
    outcomeId: String(row.outcomeId ?? row.outcome_id ?? ''),
    outcomeDesc: row.outcomeDesc ?? row.outcomeName ?? row.outcome ?? row.desc ?? '',
    odds: parseNumber(row.odds),
    specifier: row.specifier ?? null,
  };
}

// Flatten the markets embedded in a SportyBet event object (prematch list row
// or event-detail payload) into normalized outcome rows. Only real SportyBet
// event/market/outcome IDs are ever produced here, so booking stays valid.
function flattenDetailedMarkets(payload, eventContext = {}) {
  const root = unwrapData(payload) || {};
  const markets = Array.isArray(root.markets)
    ? root.markets
    : Array.isArray(root?.event?.markets) ? root.event.markets
    : Array.isArray(root?.odds?.markets) ? root.odds.markets
    : [];
  const eventId = String(root.eventId ?? root.event_id ?? root?.event?.eventId ?? root?.event?.event_id ?? eventContext.eventId ?? eventContext.event_id ?? '');
  const home = root.homeTeamName ?? root.home_team ?? root.homeTeam ?? root?.event?.homeTeamName ?? root?.event?.home_team ?? eventContext.home ?? eventContext.home_team ?? eventContext.homeTeamName ?? '';
  const away = root.awayTeamName ?? root.away_team ?? root.awayTeam ?? root?.event?.awayTeamName ?? root?.event?.away_team ?? eventContext.away ?? eventContext.away_team ?? eventContext.awayTeamName ?? '';
  const start = root.estimateStartTime ?? root.start_time ?? root.startTime ?? root?.event?.estimateStartTime ?? root?.event?.start_time ?? eventContext.estimateStartTime ?? eventContext.kickoffUtc ?? eventContext.start_time ?? null;
  const tournament = root.tournament_name ?? root.tournament ?? (root.tournament && root.tournament.name) ?? root?.event?.tournament_name ?? eventContext.tournament ?? eventContext.tournament_name ?? '';
  const category = root.category ?? (root.category && root.category.name) ?? root?.event?.category ?? eventContext.category ?? '';
  const sportLabel = eventContext.sport || 'Football';
  const rows = [];
  for (const m of markets) {
    const marketId = String(m.marketId ?? m.market_id ?? m.id ?? '');
    const marketDesc = m.desc ?? m.description ?? m.name ?? m.market_name ?? '';
    const specifier = m.specifier ?? null;
    for (const o of (Array.isArray(m.outcomes) ? m.outcomes : [])) {
      const odds = parseNumber(o.odds ?? o.price);
      if (!eventId || !marketId || odds === null) continue;
      rows.push(normalizeOutcome({
        sport: sportLabel,
        eventId,
        homeTeamName: home,
        awayTeamName: away,
        tournament,
        category,
        estimateStartTime: start,
        marketId,
        marketDesc,
        outcomeId: o.id ?? o.outcome_id,
        outcomeDesc: o.desc ?? o.description ?? o.name ?? o.outcome_name,
        odds,
        specifier: o.specifier ?? specifier,
      }, sportLabel));
    }
  }
  return rows.filter(r => r.eventId && r.home && r.away && r.outcomeId && r.odds !== null);
}

function isDetailedMarketRow(row, kind) {
  const text = `${row.marketDesc || ''} ${row.outcomeDesc || ''} ${row.specifier || ''}`.toLowerCase();

  if (TEAM_GOAL_KINDS.includes(kind)) {
    const side = kind.startsWith('home_') ? 'home' : 'away';
    const under45 = kind.endsWith('_ou45');
    return isTeamTotalSelection(row, side, under45 ? '4.5' : '0.5', under45 ? 'under' : 'over');
  }

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

function rowMatchesConfiguredMarket(row, cfg) {
  if (cfg.marketId && String(row.marketId) === String(cfg.marketId)) {
    if (!cfg.specifier) return true;
    return String(row.specifier || '').toLowerCase() === String(cfg.specifier).toLowerCase();
  }
  const text = String(row.marketDesc || '').toLowerCase();
  if (cfg.query && text.includes(String(cfg.query).toLowerCase())) {
    if (!cfg.specifier) return true;
    return String(row.specifier || '').toLowerCase() === String(cfg.specifier).toLowerCase();
  }
  return false;
}

// ---------------------------------------------------------------------------
// Direct SportyBet data access
// ---------------------------------------------------------------------------

function eventKickoffMs(e) {
  const t = Number(e.estimateStartTime ?? e.start_time ?? e.startTime ?? e.kickoffTime ?? 0);
  return t ? (t < 1e12 ? t * 1000 : t) : 0;
}

function fixtureContext(e, sportLabel) {
  return {
    eventId: String(e.eventId ?? e.event_id ?? ''),
    home: e.homeTeamName ?? e.home_team ?? e.home ?? '',
    away: e.awayTeamName ?? e.away_team ?? e.away ?? '',
    tournament: e.tournament_name ?? e.tournament ?? (e.tournament && e.tournament.name) ?? '',
    category: e.category ?? (e.category && e.category.name) ?? '',
    estimateStartTime: e.estimateStartTime ?? e.start_time ?? e.startTime ?? null,
    sport: sportLabel || 'Football',
  };
}

// Market-ID CSV sent with list requests (the site itself calls
// pcUpcomingEvents?sportId=sr:sport:1&marketId=1,18,10,29,11,26,3...). Asking
// for the IDs up front makes SportyBet embed those markets in the list payload,
// so most rows never need a per-event detail call. Override per sport with
// SPORTYBET_MARKET_IDS_FOOTBALL / _BASKETBALL / _HOCKEY / _TENNIS /
// _HANDBALL / _VOLLEYBALL (empty string = send no marketId param).
function marketIdsForSport(sport) {
  const key = String(sport || '').toLowerCase();
  const envName = `SPORTYBET_MARKET_IDS_${key.toUpperCase()}`;
  if (process.env[envName] !== undefined) return String(process.env[envName]).trim();
  const table = key === 'football' ? FOOTBALL_MARKETS : (SPORT_CONFIG[key] && SPORT_CONFIG[key].markets) || {};
  const ids = [];
  for (const cfg of Object.values(table)) {
    if (cfg && cfg.marketId && !ids.includes(String(cfg.marketId))) ids.push(String(cfg.marketId));
  }
  // Extra football IDs observed in the site's own list request; they widen the
  // embedded market set at no extra request cost.
  if (key === 'football') for (const extra of ['3', '26']) if (!ids.includes(extra)) ids.push(extra);
  return ids.join(',');
}

async function fetchPrematchEvents(sportId, { maxPages = 5, pageSize = 100, marketIds = '' } = {}) {
  const pageLimit = Math.max(1, Math.min(20, parseInt(maxPages, 10) || 5));
  const events = [];
  const seen = new Set();
  for (let page = 1; page <= pageLimit; page++) {
    const payload = await cachedFetch('prematch', `${sportId}|${marketIds}|${page}|${pageSize}`, () =>
      direct.fetchPrematchPage(sportId, page, pageSize, { marketIds }));
    const parsed = extractUpcomingEvents(payload);
    if (!parsed.events.length) break;
    let added = 0;
    for (const e of parsed.events) {
      const id = String(e.eventId ?? e.event_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      events.push(e);
      added++;
    }
    // If the server ignored the pagination params it returns the same page
    // again; stop instead of re-fetching identical payloads.
    if (added === 0) break;
    if (parsed.events.length < pageSize) break;
    if (events.length >= (parsed.total || Infinity)) break;
  }
  return events;
}

// Live events move too fast for the prematch caches: a very short TTL only
// collapses simultaneous page requests, never serves stale odds to booking.
const LIVE_CACHE_SECONDS = Math.max(5, Math.min(60, parseInt(process.env.SPORTYBET_LIVE_CACHE_SECONDS || '15', 10) || 15));

async function fetchLiveEvents(sportId, { maxPages = 5, pageSize = 100, marketIds = '' } = {}) {
  const pageLimit = Math.max(1, Math.min(20, parseInt(maxPages, 10) || 5));
  const events = [];
  const seen = new Set();
  for (let page = 1; page <= pageLimit; page++) {
    const cacheKey = `live|${sportId}|${marketIds}|${page}|${pageSize}`;
    const now = Date.now();
    let payload;
    const hit = responseCache.get(cacheKey);
    if (hit && hit.expiresAt > now) {
      usageLog('live', 'cacheHit');
      payload = hit.payload;
    } else {
      if (hit) responseCache.delete(cacheKey);
      usageLog('live', 'upstream');
      payload = await direct.fetchLivePage(sportId, page, pageSize, { marketIds });
      responseCache.set(cacheKey, { payload, expiresAt: now + LIVE_CACHE_SECONDS * 1000 });
    }
    const parsed = extractUpcomingEvents(payload);
    if (!parsed.events.length) break;
    let added = 0;
    for (const e of parsed.events) {
      const id = String(e.eventId ?? e.event_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      events.push(e);
      added++;
    }
    if (added === 0) break; // pagination params ignored — same page again
    if (parsed.events.length < pageSize) break;
    if (events.length >= (parsed.total || Infinity)) break;
  }
  return events;
}

async function fetchEventMarketsFlattened(eventId, context) {
  const payload = await cachedFetch('eventDetail', String(eventId), () => direct.fetchEventDetail(eventId));
  return flattenDetailedMarkets(payload, context);
}

// Scan prematch pages, flatten every embedded market and keep rows matching the
// requested market. Special markets that are not embedded in the list payload
// get a bounded per-event detail fallback (cheap now that there is no
// per-request credit cost, but still rate-polite).
async function collectMarketRows(sportId, matchRow, { hours = 96, maxPages = null, fallbackFilter = null, sportLabel = 'Football', live = false, marketIds = '' } = {}) {
  const pageSize = Math.max(1, Math.min(100, parseInt(process.env.SPORTYBET_PAGE_SIZE || '100', 10)));
  const fallbackMaxEvents = Math.max(0, Math.min(100, parseInt(process.env.SPORTYBET_DETAIL_EVENT_ODDS_FALLBACK || '20', 10)));
  const cutoff = Date.now() + Math.max(1, Number(hours || 96)) * 3600 * 1000;
  const rows = [];
  const fallbackEvents = [];
  let scannedEvents = 0;

  const events = live
    ? await fetchLiveEvents(sportId, { maxPages, pageSize, marketIds })
    : await fetchPrematchEvents(sportId, { maxPages, pageSize, marketIds });
  for (const e of events) {
    const ms = eventKickoffMs(e);
    // Live events already started; only prematch applies the horizon cutoff.
    if (!live && ms && ms > cutoff) continue;
    scannedEvents++;
    const ctx = fixtureContext(e, sportLabel);
    const embedded = flattenDetailedMarkets(e, ctx);
    const matched = embedded.filter(matchRow);
    if (matched.length) rows.push(...matched);
    else if (fallbackFilter && fallbackEvents.length < fallbackMaxEvents && ctx.eventId) fallbackEvents.push({ ctx, raw: e });
  }

  if (rows.length === 0 && fallbackFilter && fallbackMaxEvents > 0) {
    console.log(`[SportyBet direct] embedded=0 for special market; inspecting up to ${fallbackEvents.length} event-detail payloads (shared/cached by eventId)`);
    for (const { ctx } of fallbackEvents.slice(0, fallbackMaxEvents)) {
      try {
        rows.push(...(await fetchEventMarketsFlattened(ctx.eventId, ctx)).filter(fallbackFilter));
      } catch (err) {
        console.warn(`SportyBet event detail ${ctx.eventId}: ${err.message}`);
      }
    }
  }

  const dedup = new Map();
  for (const r of rows) {
    const key = [r.eventId, r.marketId, r.outcomeId, r.specifier || ''].join('|');
    if (!dedup.has(key)) dedup.set(key, r);
  }
  return { rows: [...dedup.values()], scannedEvents };
}

// ---------------------------------------------------------------------------
// Team-goal bundle (home/away 0.5 over + 4.5 under share each event payload)
// ---------------------------------------------------------------------------

function nigeriaFixture(row) {
  const eventId = String(row?.sportyEventId || row?.eventId || row?.event_id || '');
  const home = row?.home || row?.homeTeamName || row?.home_team || '';
  const away = row?.away || row?.awayTeamName || row?.away_team || '';
  const kickoff = row?.kickoffUtc ?? row?.estimateStartTime ?? row?.kickoffTime ?? row?.start_time ?? null;
  const timestamp = typeof kickoff === 'number' ? (kickoff < 1e12 ? kickoff * 1000 : kickoff) : Date.parse(kickoff || '');
  return {
    eventId, home, away, kickoffUtc: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    tournament: row?.tournament || row?.league || '',
  };
}

async function getTeamGoalBundle({ hours = 96, fixtures = null } = {}) {
  const limit = Math.max(1, Math.min(30, Number(process.env.SPORTYBET_TEAM_GOAL_MAX_EVENTS || 12)));
  const horizon = Date.now() + Number(hours || 96) * 3600000;
  const rowsByKind = Object.fromEntries(TEAM_GOAL_KINDS.map(kind => [kind, []]));
  const diagnostics = { source: 'SportyBet direct event markets', scannedEvents: 0, failedEvents: 0,
    eligibleFixtures: 0, offeredRows: {}, errors: [], status: '', maxEvents: limit };
  let input = fixtures;
  if (!Array.isArray(input)) {
    // Direct football-market calls have no prediction argument. Use the upcoming
    // fixture list only in that case; Auto passes saved fixtures.
    input = await fetchPrematchEvents(SPORT_IDS.football, { maxPages: 1, pageSize: 100, marketIds: marketIdsForSport('football') });
  }
  const seen = new Set();
  const selected = [];
  for (const item of input) {
    const f = nigeriaFixture(item);
    if (!f.eventId || seen.has(f.eventId) || !f.home || !f.away) continue;
    const kickoffMs = Date.parse(f.kickoffUtc || '');
    if (Number.isFinite(kickoffMs) && (kickoffMs <= Date.now() + 60000 || kickoffMs > horizon)) continue;
    seen.add(f.eventId);
    selected.push(f);
  }
  selected.sort((a, b) => Date.parse(a.kickoffUtc || '') - Date.parse(b.kickoffUtc || ''));
  diagnostics.eligibleFixtures = selected.length;
  if (!selected.length) diagnostics.status = Array.isArray(fixtures) ? 'no_saved_fixture_ids' : 'no_upcoming_fixture_ids';

  // Two concurrent event requests bound both startup delay and upstream rate.
  // A failure to reach SportyBet is surfaced distinctly from a genuine event
  // where SportyBet does not offer a 0.5/4.5 team-total line.
  const toScan = selected.slice(0, limit);
  let hardFailure = false;
  for (let i = 0; i < toScan.length && !hardFailure; i += 2) {
    const results = await Promise.all(toScan.slice(i, i + 2).map(async fixture => {
      try {
        const rows = await fetchEventMarketsFlattened(fixture.eventId, fixture);
        return { fixture, rows };
      } catch (err) {
        return { fixture, error: err };
      }
    }));
    for (const result of results) {
      diagnostics.scannedEvents++;
      if (result.error) {
        diagnostics.failedEvents++;
        if (diagnostics.errors.length < 3) diagnostics.errors.push(`${result.fixture.eventId}: ${String(result.error.message).slice(0, 160)}`);
        if (['SPORTYBET_GEO_BLOCKED', 'SPORTYBET_BOT_CHALLENGE', 'SPORTYBET_TIMEOUT', 'SPORTYBET_NETWORK'].includes(result.error.code)
          || [401, 403, 429].includes(Number(result.error.status))) hardFailure = true;
        continue;
      }
      for (const kind of TEAM_GOAL_KINDS) {
        const [side, line, direction] = TEAM_GOAL_SPECS[kind];
        rowsByKind[kind].push(...result.rows.filter(row => isTeamTotalSelection(row, side, line, direction)));
      }
    }
  }
  diagnostics.offeredRows = Object.fromEntries(TEAM_GOAL_KINDS.map(kind => [kind, rowsByKind[kind].length]));
  if (!diagnostics.status) diagnostics.status = diagnostics.scannedEvents === diagnostics.failedEvents
    ? 'event_market_endpoint_unavailable'
    : Object.values(diagnostics.offeredRows).some(Boolean)
      ? 'available'
      : 'no_exact_team_total_lines_in_scanned_events';
  console.log(`[SportyBet team totals] status=${diagnostics.status} scanned=${diagnostics.scannedEvents}/${diagnostics.eligibleFixtures} rows=${JSON.stringify(diagnostics.offeredRows)}`);
  return { rowsByKind, diagnostics };
}

async function cachedTeamGoalBundle(options) {
  const fixtures = Array.isArray(options.fixtures) ? options.fixtures : null;
  const fixtureIds = (fixtures || []).map(f => String(f?.sportyEventId || f?.eventId || '')).filter(Boolean);
  const key = `${options.hours || 96}|${fixtures ? fixtureIds.join(',') : 'direct'}`;
  const now = Date.now();
  const hit = teamGoalBundleCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  if (teamGoalBundleInFlight.has(key)) return teamGoalBundleInFlight.get(key);
  const promise = getTeamGoalBundle(options);
  teamGoalBundleInFlight.set(key, promise);
  try {
    const value = await promise;
    teamGoalBundleCache.set(key, { expiresAt: Date.now() + 300000, value });
    if (teamGoalBundleCache.size > 20) teamGoalBundleCache.delete(teamGoalBundleCache.keys().next().value);
    return value;
  } finally {
    teamGoalBundleInFlight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Public interface consumed by server.js / jobs / Telegram / Analyzer
// ---------------------------------------------------------------------------

async function getFootballMarket(kind, { hours = 96, maxPages = null, fixtures = null } = {}) {
  const cfg = FOOTBALL_MARKETS[kind];
  if (!cfg) throw new Error(`Unsupported SportyBet football market: ${kind}`);
  if (TEAM_GOAL_KINDS.includes(kind)) {
    const bundle = await cachedTeamGoalBundle({ hours, fixtures });
    const normalized = bundle.rowsByKind[kind] || [];
    return { sport: 'football', market: kind, fetchedAt: new Date().toISOString(),
      source: 'SportyBet direct (dummy account session)', totalReturned: normalized.length,
      rows: normalized, teamGoalDiagnostics: bundle.diagnostics };
  }

  const isSpecial = SPECIAL_FOOTBALL_KINDS.has(kind);
  const matchRow = isSpecial
    ? (r) => isDetailedMarketRow(r, kind)
    : (r) => rowMatchesConfiguredMarket(r, cfg);
  const { rows } = await collectMarketRows(SPORT_IDS.football, matchRow, {
    hours,
    maxPages,
    // If the list payload embeds only SportyBet's default line for a market
    // (e.g. Over/Under 2.5), specifier-specific kinds like Over 1.5/Under 4.5
    // come back empty; the bounded, cached per-event detail fallback then reads
    // the full market list for those events.
    fallbackFilter: matchRow,
    marketIds: marketIdsForSport('football'),
  });

  let normalized = rows;
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
    source: 'SportyBet direct (dummy account session)',
    totalReturned: normalized.length,
    rows: normalized,
  };
}

async function getSportMarket(sport, kind, { hours = 96, maxPages = null } = {}) {
  const cfg = SPORT_CONFIG[sport];
  if (!cfg) throw new Error(`Unsupported SportyBet sport: ${sport}`);
  const marketCfg = cfg.markets[kind || cfg.defaultMarket];
  if (!marketCfg) throw new Error(`Unsupported ${sport} market: ${kind}`);
  const sportId = SPORT_IDS[sport];
  if (!sportId) throw new Error(`No SportyBet sport id configured for: ${sport}`);

  const { rows } = await collectMarketRows(sportId, (r) => rowMatchesConfiguredMarket(r, marketCfg), {
    hours,
    maxPages,
    sportLabel: SPORT_LABELS[sport],
    marketIds: marketIdsForSport(sport),
    // Other sports have fewer known market IDs; when the list payload does not
    // embed the requested bet type, fall back to bounded per-event detail reads.
    fallbackFilter: (r) => rowMatchesConfiguredMarket(r, marketCfg),
  });

  return {
    sport,
    market: kind || cfg.defaultMarket,
    marketLabel: marketCfg.label,
    fetchedAt: new Date().toISOString(),
    source: 'SportyBet direct (dummy account session)',
    totalReturned: rows.length,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Live / in-play scraping and booking validation
// ---------------------------------------------------------------------------

// Scrape the SportyBet live betting board. market='all' returns every offered
// market for every live event (all leagues/divisions); otherwise rows are
// filtered to the requested bet type. Rows carry real SportyBet IDs, so they
// can be booked directly.
async function getLiveSportMarket(sport, kind, { maxPages = null } = {}) {
  const sportKey = String(sport || 'football').toLowerCase();
  const sportId = SPORT_IDS[sportKey];
  if (!sportId) throw new Error(`Unsupported SportyBet live sport: ${sportKey}`);
  const kindKey = String(kind || 'all').toLowerCase();

  let matchRow;
  let marketLabel = 'All live markets';
  if (kindKey === 'all') {
    matchRow = () => true;
  } else if (sportKey === 'football' && FOOTBALL_MARKETS[kindKey]) {
    const cfg = FOOTBALL_MARKETS[kindKey];
    const isSpecial = SPECIAL_FOOTBALL_KINDS.has(kindKey);
    matchRow = isSpecial ? (r) => isDetailedMarketRow(r, kindKey) : (r) => rowMatchesConfiguredMarket(r, cfg);
    marketLabel = cfg.query;
  } else if (SPORT_CONFIG[sportKey]) {
    const cfg = SPORT_CONFIG[sportKey];
    const marketCfg = cfg.markets[kindKey] || cfg.markets[cfg.defaultMarket];
    matchRow = (r) => rowMatchesConfiguredMarket(r, marketCfg);
    marketLabel = marketCfg.label;
  } else {
    throw new Error(`Unsupported live market for ${sportKey}: ${kindKey}`);
  }

  // No per-event detail fallback for live: the detail cache is prematch-paced
  // and live odds must never come from a stale payload.
  const { rows, scannedEvents } = await collectMarketRows(sportId, matchRow, {
    maxPages,
    sportLabel: SPORT_LABELS[sportKey] || sportKey,
    live: true,
    marketIds: marketIdsForSport(sportKey),
  });

  return {
    sport: sportKey,
    market: kindKey,
    marketLabel,
    live: true,
    fetchedAt: new Date().toISOString(),
    source: 'SportyBet live board (direct)',
    scannedEvents,
    totalReturned: rows.length,
    rows,
  };
}

// Re-scrape the live board fresh (no cache) and confirm every selection is
// still offered before a live booking code is created. Live odds suspend and
// re-open constantly; booking stale IDs would produce rejected or wrong slips.
async function validateLiveSelections(selections, { maxPages = 5 } = {}) {
  const bySport = new Map();
  for (const s of selections) {
    const sportKey = String(s.sport || 'football').toLowerCase();
    if (!bySport.has(sportKey)) bySport.set(sportKey, []);
    bySport.get(sportKey).push(s);
  }
  const valid = [];
  const dropped = [];
  const pageSize = 100;
  const pageLimit = Math.max(1, Math.min(20, parseInt(maxPages, 10) || 5));
  const keyOf = s => [String(s.eventId), String(s.marketId), String(s.outcomeId), String(s.specifier || '')].join('|');

  for (const [sportKey, list] of bySport) {
    const sportId = SPORT_IDS[sportKey];
    if (!sportId) {
      list.forEach(s => dropped.push({ ...s, dropReason: `unsupported sport: ${sportKey}` }));
      continue;
    }
    const wanted = new Set(list.map(s => String(s.eventId)));
    const liveMarketIds = marketIdsForSport(sportKey);
    const events = [];
    for (let page = 1; page <= pageLimit; page++) {
      const payload = await direct.fetchLivePage(sportId, page, pageSize, { marketIds: liveMarketIds }); // fresh, uncached
      const parsed = extractUpcomingEvents(payload);
      if (!parsed.events.length) break;
      events.push(...parsed.events);
      const foundAll = [...wanted].every(id => events.some(e => String(e.eventId ?? e.event_id ?? '') === id));
      if (foundAll || parsed.events.length < pageSize) break;
    }
    const liveRows = [];
    for (const e of events) {
      const id = String(e.eventId ?? e.event_id ?? '');
      if (!wanted.has(id)) continue;
      liveRows.push(...flattenDetailedMarkets(e, fixtureContext(e, SPORT_LABELS[sportKey])));
    }
    const liveMap = new Map(liveRows.map(r => [keyOf(r), r]));
    for (const s of list) {
      const liveRow = liveMap.get(keyOf(s));
      if (liveRow) {
        valid.push({ ...s, odds: liveRow.odds, home: liveRow.home, away: liveRow.away, liveValidatedAt: new Date().toISOString() });
      } else {
        dropped.push({ ...s, dropReason: 'no longer offered on the live board (suspended, settled or removed)' });
      }
    }
  }
  return { valid, dropped };
}

async function getBooking(bookingCode, { fresh = false } = {}) {
  const code = String(bookingCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,24}$/.test(code)) {
    const err = new Error('Invalid SportyBet booking code');
    err.code = 'INVALID_BOOKING_CODE';
    throw err;
  }
  const payload = await cachedFetch('booking', code + (fresh ? `|${Date.now()}` : ''), () =>
    direct.lookupBooking(code, { fresh }));
  return payload && payload.data !== undefined ? payload.data : payload;
}

function normalizeBookingResult(payload) {
  const raw = payload && payload.data !== undefined ? payload.data : payload;
  if (!raw || typeof raw !== 'object') return raw;

  return {
    ...raw,
    shareCode: raw.shareCode ?? raw.bookingCode ?? raw.booking_code ?? raw.share_code ?? raw.code ?? null,
    shareURL: raw.shareURL ?? raw.shareUrl ?? raw.share_url ?? raw.url ?? null,
    unavailableOutcomes: raw.unavailableOutcomes ?? raw.unavailable_outcomes ?? [],
  };
}

function hasBookingCode(result) {
  return !!(result && result.shareCode);
}

async function bookBet(selections, { preferFullMarket = false } = {}) {
  // preferFullMarket is accepted for interface compatibility with the removed
  // Parse dual-scraper flow; the direct client always books through the same
  // authenticated dummy-account session.
  void preferFullMarket;
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error('selections must be a non-empty array');
  }

  const cleaned = selections.map(s => ({
    eventId: String(s.eventId || ''),
    marketId: String(s.marketId || ''),
    outcomeId: String(s.outcomeId || ''),
    ...(s.specifier !== undefined && s.specifier !== null && String(s.specifier) !== ''
      ? { specifier: String(s.specifier) }
      : {}),
  }));

  if (cleaned.some(s => !s.eventId || !s.marketId || !s.outcomeId)) {
    throw new Error('Each selection requires eventId, marketId and outcomeId');
  }

  try {
    const payload = await direct.createBookingCode(cleaned);
    const result = normalizeBookingResult(payload);
    if (hasBookingCode(result)) return result;
    const err = new Error('SportyBet booking failed: no booking code returned');
    err.code = 'SPORTYBET_BOOKING_FAILED';
    throw err;
  } catch (err) {
    if (err.code === 'SPORTYBET_TIMEOUT') {
      const e = new Error(`SportyBet booking timed out. ${err.message}`);
      e.code = 'SPORTYBET_BOOKING_TIMEOUT';
      throw e;
    }
    if (err.code === 'SPORTYBET_BOOKING_FAILED') throw err;
    const e = new Error(`SportyBet booking failed. ${err.message}`);
    e.code = err.code === 'SPORTYBET_NOT_CONFIGURED' || err.code === 'SPORTYBET_AUTH_FAILED' ? err.code : 'SPORTYBET_BOOKING_FAILED';
    throw e;
  }
}

// Start the dummy-account keep-alive loop as soon as credentials exist. The
// timer is unref'd so one-off jobs (jobs/refresh.js etc.) can still exit.
if (direct.credentialsConfigured()) {
  direct.startKeepAlive();
}

module.exports = {
  FOOTBALL_MARKETS,
  SPORT_CONFIG,
  SPORT_IDS,
  getFootballMarket,
  getSportMarket,
  getLiveSportMarket,
  validateLiveSelections,
  getBooking,
  bookBet,
  normalizeOutcome,
  flattenDetailedMarkets,
  isDetailedMarketRow,
  marketIdsForSport,
  direct,
};
