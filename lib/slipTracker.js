const TRACKER_KEY = 'telegram:tracked-slips:v1';
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
    odds: Number(x.odds) || null,
    kickoffUtc: x.kickoffUtc || null,
  };
}

async function readAll(redis) {
  if (redis) {
    const raw = await redis.get(TRACKER_KEY);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [...memory.values()];
}

async function writeAll(redis, slips) {
  if (redis) {
    await redis.set(TRACKER_KEY, JSON.stringify(slips));
    return;
  }
  memory.clear();
  slips.forEach(s => memory.set(s.shareCode, s));
}

async function trackTelegramSlip(redis, { shareCode, shareURL, targetOdds, combinedOdds, sportScope, selections }) {
  const code = String(shareCode || '').trim().toUpperCase();
  if (!code) return null;
  const all = await readAll(redis);
  const existing = all.find(x => x.shareCode === code);
  if (existing) return existing;
  const slip = {
    shareCode: code,
    shareURL: shareURL || null,
    targetOdds: Number(targetOdds) || null,
    combinedOdds: Number(combinedOdds) || null,
    sportScope: String(sportScope || 'all'),
    selections: Array.isArray(selections) ? selections.map(cleanSelection) : [],
    createdAt: nowIso(),
    status: 'pending',
    successAlertSent: false,
    successAlertSentAt: null,
    lastCheckedAt: null,
    lastStatusDetail: null,
  };
  all.push(slip);
  const keepDays = Math.max(7, Math.min(180, parseInt(process.env.TELEGRAM_TRACK_DAYS || '45', 10)));
  const cutoff = Date.now() - keepDays * 86400000;
  await writeAll(redis, all.filter(x => new Date(x.createdAt).getTime() >= cutoff || x.status === 'pending'));
  return slip;
}

async function listTrackedSlips(redis) { return readAll(redis); }

async function updateTrackedSlip(redis, shareCode, patch) {
  const all = await readAll(redis);
  const idx = all.findIndex(x => x.shareCode === String(shareCode || '').toUpperCase());
  if (idx < 0) return null;
  all[idx] = { ...all[idx], ...patch };
  await writeAll(redis, all);
  return all[idx];
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
  const keys = ['winningStatus','winning_status','winStatus','settlementStatus','settlement_status','result','betResult','bet_result','outcomeStatus','outcome_status','status'];
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  for (const k of ['isWinning','is_winning','isWon','won']) if (obj[k] === true) return 'won';
  // A false is intentionally NOT treated as a loss: some SportyBet payloads use
  // false while an event is merely pending. We only mark losses from explicit text.
  return null;
}

function normalizeStatus(value) {
  if (value === null || value === undefined) return 'unknown';
  const s = String(value).trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!s) return 'unknown';
  if (/\b(won|win|winning|success|successful|settled won|paid)\b/.test(s)) return 'won';
  if (/\b(void|push|pushed|refund|refunded|cancelled|canceled)\b/.test(s)) return 'push';
  if (/\b(lost|lose|loss|losing|failed)\b/.test(s)) return 'lost';
  if (/\b(pending|open|unsettled|not start|not started|live|running|in play|inplay|scheduled)\b/.test(s)) return 'pending';
  return 'unknown';
}

function evaluateBooking(booking) {
  const outcomes = extractOutcomes(booking);
  const legStatuses = outcomes.map(x => normalizeStatus(statusValue(x)));
  const topStatus = normalizeStatus(statusValue(booking));
  if (topStatus === 'won') return { status: 'won', legStatuses, topStatus };
  if (topStatus === 'lost') return { status: 'lost', legStatuses, topStatus };
  if (legStatuses.some(x => x === 'lost')) return { status: 'lost', legStatuses, topStatus };
  if (legStatuses.length && legStatuses.every(x => x === 'won' || x === 'push')) return { status: 'won', legStatuses, topStatus };
  return { status: 'pending', legStatuses, topStatus };
}

module.exports = { trackTelegramSlip, listTrackedSlips, updateTrackedSlip, evaluateBooking };
