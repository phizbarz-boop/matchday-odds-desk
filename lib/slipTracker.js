const TRACKER_KEY = 'telegram:tracked-slips:v1';
const TICKETS_KEY = 'telegram:tracked-tickets:v2';
const memory = new Map();

function nowIso() { return new Date().toISOString(); }

function cleanSelection(x = {}) {
  return {
    sport: String(x.sport || '').slice(0, 30),
    eventId: String(x.eventId || '').slice(0, 100),
    marketId: String(x.marketId || '').slice(0, 60),
    outcomeId: String(x.outcomeId || '').slice(0, 100),
    specifier: x.specifier ? String(x.specifier).slice(0, 120) : null,
    home: String(x.home || '').slice(0, 120),
    away: String(x.away || '').slice(0, 120),
    outcomeDesc: String(x.outcomeDesc || x.marketDesc || '').slice(0, 140),
    marketDesc: String(x.marketDesc || '').slice(0, 160),
    betType: String(x.betType || '').slice(0, 70),
    odds: Number(x.odds) || null,
    kickoffUtc: x.kickoffUtc || null,
  };
}

async function readAll(redis) {
  if (redis) {
    const raw = await redis.get(TRACKER_KEY);
    let legacy = [];
    try { legacy = JSON.parse(raw || '[]'); } catch {}
    if (!Array.isArray(legacy)) legacy = [];
    const current = (await redis.hVals(TICKETS_KEY)).map(row => JSON.parse(row));
    const byId = new Map(legacy.map(row => [row.ticketId || row.shareCode, row]));
    for (const row of current) byId.set(row.ticketId || row.shareCode, row);
    return [...byId.values()];
  }
  return [...memory.values()];
}

async function writeTicket(redis, slip) {
  const id = slip.ticketId || slip.shareCode;
  if (redis) await redis.hSet(TICKETS_KEY, id, JSON.stringify(slip));
  else memory.set(id, slip);
}

async function trackTelegramSlip(redis, { shareCode, shareURL, targetOdds, combinedOdds, sportScope, selections,
  ticketId, label, hourKey, liveMode, minProbability, delivery = 'posted', createdAt }) {
  const code = String(shareCode || '').trim().toUpperCase();
  if (!code) return null;
  const all = await readAll(redis);
  const id = String(ticketId || code);
  const existing = all.find(x => (x.ticketId || x.shareCode) === id);
  if (existing && existing.delivery !== 'prepared') return existing;
  const slip = {
    shareCode: code,
    ticketId: id,
    label: String(label || targetOdds || 'Auto pick'),
    source: 'telegram_auto',
    hourKey: hourKey || null,
    liveMode: liveMode || 'prematch',
    minProbability: minProbability ?? null,
    delivery,
    shareURL: shareURL || null,
    targetOdds: Number(targetOdds) || null,
    combinedOdds: Number(combinedOdds) || null,
    sportScope: String(sportScope || 'all'),
    selections: Array.isArray(selections) ? selections.map(cleanSelection) : [],
    createdAt: createdAt || nowIso(),
    status: 'pending',
    successAlertSent: false,
    successAlertSentAt: null,
    lastCheckedAt: null,
    lastStatusDetail: null,
  };
  // A hash field per published ticket prevents hourly/daily/report workers
  // overwriting one another. Retain results for cumulative hypothetical ROI.
  await writeTicket(redis, slip);
  return slip;
}

async function listTrackedSlips(redis) { return readAll(redis); }

async function updateTrackedSlip(redis, shareCode, patch) {
  const all = await readAll(redis);
  const row = all.find(x => x.shareCode === String(shareCode || '').toUpperCase());
  return row ? updateTrackedTicket(redis, row.ticketId || row.shareCode, patch) : null;
}

async function updateTrackedTicket(redis, ticketId, patch) {
  const row = (await readAll(redis)).find(x => (x.ticketId || x.shareCode) === ticketId);
  if (!row) return null;
  const updated = { ...row, ...patch };
  await writeTicket(redis, updated);
  return updated;
}

function extractOutcomes(booking) {
  if (!booking || typeof booking !== 'object') return [];
  for (const key of ['outcomes', 'selections', 'bets', 'items']) {
    if (Array.isArray(booking[key])) return booking[key];
  }
  if (booking.data && typeof booking.data === 'object') return extractOutcomes(booking.data);
  return [];
}

function statusValue(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = [
    'bookingSettlement','booking_settlement',
    'settlement','selectionSettlement','selection_settlement',
    'winningStatus','winning_status','winStatus',
    'settlementStatus','settlement_status',
    'result','betResult','bet_result',
    'outcomeStatus','outcome_status','status'
  ];
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      const parsed = primitiveSettlementValue(obj[k]);
      if (parsed !== null) return parsed;
    }
  }
  for (const k of ['isWinning','is_winning','isWon','won']) if (obj[k] === true) return 'won';
  return null;
}

function normalizeStatus(value) {
  if (value === null || value === undefined) return 'unknown';
  const s = String(value).trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!s) return 'unknown';
  if (/\b(won|win|winning|success|successful|settled won|paid|winner)\b/.test(s)) return 'won';
  if (/\b(void|push|pushed|refund|refunded|cancelled|canceled|cancel)\b/.test(s)) return 'push';
  if (/\b(lost|lose|loss|losing|failed|loser)\b/.test(s)) return 'lost';
  if (/\b(pending|open|unsettled|not start|not started|live|running|in play|inplay|scheduled|unknown)\b/.test(s)) return 'pending';
  return 'unknown';
}


function primitiveSettlementValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'object') return value;

  // SportyBet may wrap settlement in an object.
  for (const key of [
    'status','settlement','bookingSettlement','booking_settlement',
    'settlementStatus','settlement_status','result','value','name','code'
  ]) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
      const nested = primitiveSettlementValue(value[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function bookingSettlementValue(booking) {
  if (!booking || typeof booking !== 'object') return null;

  // Overall booking settlement is authoritative and must be checked first.
  for (const key of [
    'bookingSettlement','booking_settlement',
    'overallSettlement','overall_settlement',
    'settlementStatus','settlement_status',
    'betResult','bet_result','status'
  ]) {
    const raw = booking[key];
    const parsed = primitiveSettlementValue(raw);
    if (parsed !== null) return parsed;
  }

  // Common wrappers returned by upstream APIs.
  for (const key of ['data','booking','betSlip','betslip','payload','result']) {
    if (booking[key] && typeof booking[key] === 'object') {
      const nested = bookingSettlementValue(booking[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function evaluateBooking(booking) {
  const outcomes = extractOutcomes(booking);
  const legDetails = outcomes.map((x, index) => ({
    index: index + 1,
    status: normalizeStatus(statusValue(x)),
    sport: String(x?.sport || x?.sportName || ''),
    home: String(x?.home || x?.homeTeam || x?.homeTeamName || ''),
    away: String(x?.away || x?.awayTeam || x?.awayTeamName || ''),
    market: String(x?.marketDesc || x?.market || ''),
    outcome: String(x?.outcomeDesc || x?.outcome || ''),
  }));
  const legStatuses = legDetails.map(x => x.status);
  const topStatus = normalizeStatus(bookingSettlementValue(booking) ?? statusValue(booking));
  const counts = legStatuses.reduce((acc, status) => {
    if (status === 'won') acc.won++;
    else if (status === 'lost') acc.lost++;
    else if (status === 'push') acc.push++;
    else if (status === 'pending') acc.pending++;
    else acc.unknown++;
    return acc;
  }, { won:0, lost:0, push:0, pending:0, unknown:0 });

  let status = 'pending';

  // IMPORTANT: the overall SportyBet booking settlement is authoritative.
  // Never allow a stale/misclassified individual leg to overturn a confirmed
  // overall WON booking shown on the SportyBet dashboard.
  if (topStatus === 'won') status = 'won';
  else if (topStatus === 'lost') status = 'lost';
  else if (legStatuses.some(x => x === 'lost')) status = 'lost';
  else if (legStatuses.length && legStatuses.every(x => x === 'won' || x === 'push')) status = 'won';

  return {
    status,
    topStatus,
    legStatuses,
    legDetails,
    counts,
    totalLegs: legStatuses.length,
    boomed: status === 'won',
    rawBookingSettlement: bookingSettlementValue(booking),
  };
}

module.exports = { trackTelegramSlip, listTrackedSlips, updateTrackedSlip, updateTrackedTicket, evaluateBooking };
