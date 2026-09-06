const crypto = require('crypto');

const COPY_HUB_KEY = 'copyhub:v1';
const memory = { punters: {}, entries: [], scannedSourceIds: [], codeOwners: {} };
let mutationQueue = Promise.resolve();

function nowIso() { return new Date().toISOString(); }
function asIso(v) {
  const d = new Date(v || Date.now());
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString();
}
function cleanText(v, max = 160) { return String(v || '').trim().slice(0, max); }
function normalizeSource(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'twitter') return 'x';
  return ['x', 'sportysocial', 'telegram', 'manual'].includes(s) ? s : 'manual';
}
function slug(v) { return String(v || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80); }
function punterId(source, username, sourceUserId = null) {
  const src = normalizeSource(source);
  // SportySocial exposes a stable SportyBet userId. Prefer it over nickname because
  // display names can be duplicated or changed while the platform id remains stable.
  const stable = src === 'sportysocial' && cleanText(sourceUserId, 100)
    ? `uid:${cleanText(sourceUserId, 100)}`
    : `name:${slug(username) || 'unknown'}`;
  const base = `${src}:${stable}`;
  return `${src}_${crypto.createHash('sha256').update(base).digest('hex').slice(0, 14)}`;
}
function validHttpUrl(value, allowedHosts = []) {
  try {
    const u = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (allowedHosts.length && !allowedHosts.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
    return u.href.slice(0, 500);
  } catch { return null; }
}
function safeProfileUrl(source, username, supplied) {
  const src = normalizeSource(source);
  if (src === 'x') return validHttpUrl(supplied, ['x.com', 'twitter.com']) || `https://x.com/${encodeURIComponent(slug(username))}`;
  if (src === 'sportysocial') return validHttpUrl(supplied, ['sportybet.com']) || `https://www.sportybet.com/ng/m/player/${encodeURIComponent(slug(username))}`;
  if (src === 'telegram') return validHttpUrl(supplied, ['t.me', 'telegram.me']);
  return validHttpUrl(supplied);
}

function finiteTime(value) {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}
function hasReliablePublishedAt(entry) {
  if (entry?.publishedAtVerified === true) return true;
  if (entry?.publishedAtVerified === false) return false;
  // Backward-compatible inference for records created before ownership tracking existed.
  const src = normalizeSource(entry?.source);
  return Boolean(entry?.publishedAt && entry?.sourcePostId && ['x', 'sportysocial', 'telegram'].includes(src));
}
function compareOwnershipCandidates(a, b) {
  const aReliable = hasReliablePublishedAt(a);
  const bReliable = hasReliablePublishedAt(b);
  if (aReliable !== bReliable) return aReliable ? -1 : 1;
  const primaryA = aReliable ? finiteTime(a.publishedAt) : finiteTime(a.capturedAt);
  const primaryB = bReliable ? finiteTime(b.publishedAt) : finiteTime(b.capturedAt);
  if (primaryA !== primaryB) return primaryA - primaryB;
  const capturedDiff = finiteTime(a.capturedAt) - finiteTime(b.capturedAt);
  if (capturedDiff) return capturedDiff;
  return String(a.id || '').localeCompare(String(b.id || ''));
}
function ownerMetaFromEntry(entry) {
  if (!entry) return null;
  return {
    bookingCode: String(entry.bookingCode || '').toUpperCase(),
    ownerEntryId: entry.id || null,
    ownerPunterId: entry.punterId || null,
    ownerSource: normalizeSource(entry.source),
    ownerPublishedAt: entry.publishedAt || null,
    ownerCapturedAt: entry.capturedAt || null,
    ownerSourcePostId: entry.sourcePostId || null,
    reliablePublishedAt: hasReliablePublishedAt(entry),
  };
}
function ownerMetaAsCandidate(meta) {
  if (!meta) return null;
  return {
    id: meta.ownerEntryId,
    punterId: meta.ownerPunterId,
    source: meta.ownerSource,
    bookingCode: meta.bookingCode,
    publishedAt: meta.ownerPublishedAt,
    capturedAt: meta.ownerCapturedAt,
    sourcePostId: meta.ownerSourcePostId,
    publishedAtVerified: Boolean(meta.reliablePublishedAt),
  };
}
function reconcileCodeOwnership(store) {
  store.punters = store.punters && typeof store.punters === 'object' ? store.punters : {};
  store.entries = Array.isArray(store.entries) ? store.entries : [];
  store.scannedSourceIds = Array.isArray(store.scannedSourceIds) ? store.scannedSourceIds : [];
  store.codeOwners = store.codeOwners && typeof store.codeOwners === 'object' ? store.codeOwners : {};

  const groups = new Map();
  for (const entry of store.entries) {
    const code = String(entry?.bookingCode || '').trim().toUpperCase();
    if (!code) continue;
    entry.bookingCode = code;
    if (entry.publishedAtVerified === undefined) entry.publishedAtVerified = hasReliablePublishedAt(entry);
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(entry);
  }

  for (const [code, rows] of groups) {
    const candidates = [...rows].sort(compareOwnershipCandidates);
    const bestVisible = candidates[0] || null;
    const storedMeta = store.codeOwners[code] || null;
    const storedCandidate = ownerMetaAsCandidate(storedMeta);
    let ownerMeta = storedMeta;

    if (!storedCandidate || (bestVisible && compareOwnershipCandidates(bestVisible, storedCandidate) < 0)) {
      ownerMeta = ownerMetaFromEntry(bestVisible);
      if (ownerMeta) store.codeOwners[code] = ownerMeta;
    }
    if (!ownerMeta && bestVisible) {
      ownerMeta = ownerMetaFromEntry(bestVisible);
      store.codeOwners[code] = ownerMeta;
    }

    // A booking code has one ranking owner globally. Later publishers are retained as reposts.
    // If the best record has no verifiable source publication timestamp, it remains UNKNOWN_ORIGIN
    // and receives no ranking credit until a verifiable public source is observed.
    for (const row of rows) {
      const isOwner = Boolean(ownerMeta?.ownerEntryId && row.id === ownerMeta.ownerEntryId);
      if (isOwner && ownerMeta.reliablePublishedAt) row.ownershipStatus = 'original';
      else if (isOwner) row.ownershipStatus = 'unknown_origin';
      else row.ownershipStatus = 'repost';
      row.ownershipRankingEligible = row.ownershipStatus === 'original';
      row.originalEntryId = ownerMeta?.ownerEntryId || null;
      row.originalPunterId = ownerMeta?.ownerPunterId || null;
      row.originalPublishedAt = ownerMeta?.ownerPublishedAt || null;
      row.ownershipReason = row.ownershipStatus === 'original'
        ? 'earliest-verified-publication'
        : row.ownershipStatus === 'repost'
          ? 'same-code-published-later'
          : 'publication-origin-unverified';
    }

    // Settlement is code-level. If any copy was already settled, mirror that result to all copies.
    const settledRows = rows.filter(x => ['won', 'lost', 'push'].includes(x.status));
    if (settledRows.length) {
      settledRows.sort((a, b) => finiteTime(b.settledAt || b.lastCheckedAt) - finiteTime(a.settledAt || a.lastCheckedAt));
      const settled = settledRows[0];
      for (const row of rows) {
        if (!['won', 'lost', 'push'].includes(row.status)) {
          row.status = settled.status;
          row.settledAt = settled.settledAt || row.settledAt || null;
        }
        if (settled.lastCheckedAt && (!row.lastCheckedAt || finiteTime(settled.lastCheckedAt) > finiteTime(row.lastCheckedAt))) row.lastCheckedAt = settled.lastCheckedAt;
      }
    }
  }
  return store;
}

async function readStore(redis) {
  if (!redis) return reconcileCodeOwnership(JSON.parse(JSON.stringify(memory)));
  const raw = await redis.get(COPY_HUB_KEY);
  if (!raw) return reconcileCodeOwnership({ punters: {}, entries: [], scannedSourceIds: [], codeOwners: {} });
  try {
    const x = JSON.parse(raw);
    return reconcileCodeOwnership({
      punters: x && typeof x.punters === 'object' && x.punters ? x.punters : {},
      entries: Array.isArray(x?.entries) ? x.entries : [],
      scannedSourceIds: Array.isArray(x?.scannedSourceIds) ? x.scannedSourceIds : [],
      codeOwners: x && typeof x.codeOwners === 'object' && x.codeOwners ? x.codeOwners : {},
    });
  } catch { return reconcileCodeOwnership({ punters: {}, entries: [], scannedSourceIds: [], codeOwners: {} }); }
}
async function writeStore(redis, store) {
  reconcileCodeOwnership(store);
  const maxEntries = Math.max(100, Math.min(10000, parseInt(process.env.COPY_HUB_MAX_ENTRIES || '3000', 10)));
  store.entries = (store.entries || []).slice(-maxEntries);
  store.scannedSourceIds = (store.scannedSourceIds || []).slice(-5000);
  if (redis) {
    await redis.set(COPY_HUB_KEY, JSON.stringify(store));
    return;
  }
  memory.punters = store.punters || {};
  memory.entries = store.entries || [];
  memory.scannedSourceIds = store.scannedSourceIds || [];
  memory.codeOwners = store.codeOwners || {};
}
function mutateStore(redis, fn) {
  const run = mutationQueue.then(async () => {
    const store = await readStore(redis);
    const result = await fn(store);
    await writeStore(redis, store);
    return result;
  });
  mutationQueue = run.catch(() => {});
  return run;
}

function walkObjects(value, out = [], depth = 0) {
  if (!value || depth > 8) return out;
  if (Array.isArray(value)) {
    for (const x of value) walkObjects(x, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    out.push(value);
    for (const x of Object.values(value)) walkObjects(x, out, depth + 1);
  }
  return out;
}
function firstNumberByKeys(value, keys) {
  const wanted = new Set(keys.map(x => x.toLowerCase()));
  for (const obj of walkObjects(value)) {
    for (const [k, v] of Object.entries(obj)) {
      if (!wanted.has(String(k).toLowerCase())) continue;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}
function selectionObjects(booking) {
  if (!booking || typeof booking !== 'object') return [];
  for (const obj of walkObjects(booking)) {
    for (const key of ['outcomes', 'selections', 'bets', 'items', 'shareCodeDetail']) {
      if (Array.isArray(obj[key]) && obj[key].length) return obj[key].filter(x => x && typeof x === 'object');
    }
  }
  return [];
}
function selectionOdds(row) {
  for (const k of ['odds', 'price', 'selection_odds', 'selectedOdds', 'selected_odds']) {
    const n = Number(row?.[k]);
    if (Number.isFinite(n) && n > 1) return n;
  }
  return null;
}
function bookingCombinedOdds(booking) {
  const direct = firstNumberByKeys(booking, ['combinedOdds', 'combined_odds', 'totalOdds', 'total_odds', 'bookingOdds', 'booking_odds']);
  if (direct && direct > 1) return direct;
  const legs = selectionObjects(booking).map(selectionOdds).filter(x => x && x > 1);
  if (!legs.length) return null;
  const product = legs.reduce((p, x) => p * x, 1);
  return Number.isFinite(product) ? product : null;
}
function eventKickoff(row) {
  const keys = ['kickoffUtc','kickoff_utc','kickoff','kickoffTime','kickOffTime','startTime','start_time','eventStartTime','eventTime','event_time','matchTime','match_time','scheduledTime','startDate','start_date','eventDate','startTimestamp'];
  for (const k of keys) {
    if (row?.[k] === undefined || row?.[k] === null) continue;
    const raw = row[k];
    const d = typeof raw === 'number' && raw < 1e12 ? new Date(raw * 1000) : new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}
function firstKickoffUtc(booking) {
  const dates = selectionObjects(booking).map(eventKickoff).filter(Boolean).map(x => new Date(x).getTime()).filter(Number.isFinite);
  return dates.length ? new Date(Math.min(...dates)).toISOString() : null;
}
function timingStatus({ publishedAt, capturedAt, firstKickoff }) {
  const pub = new Date(publishedAt || capturedAt).getTime();
  const cap = new Date(capturedAt).getTime();
  const ko = firstKickoff ? new Date(firstKickoff).getTime() : NaN;
  if (Number.isFinite(ko)) {
    // We require Matchday itself to have observed the code before kickoff. The source's
    // original timestamp alone is not enough because some platforms allow post edits.
    if (Number.isFinite(cap) && cap < ko - 30000) return { eligible: true, timingVerified: true, reason: 'captured-before-kickoff' };
    return { eligible: false, timingVerified: true, reason: 'captured-after-kickoff' };
  }
  // Without kickoff metadata we keep the record, but do not call its timing verified.
  return { eligible: true, timingVerified: false, reason: 'kickoff-unavailable' };
}

function cleanPunterInput(input = {}) {
  const source = normalizeSource(input.source);
  const username = cleanText(input.username || input.handle || input.name, 80).replace(/^@/, '');
  if (!username) throw new Error('punter username is required');
  const sourceUserId = cleanText(input.sourceUserId, 100) || null;
  const id = punterId(source, username, sourceUserId);
  const followersCount = Number(input.followersCount);
  return {
    id,
    source,
    username,
    displayName: cleanText(input.displayName || input.name || username, 100),
    profileUrl: safeProfileUrl(source, username, input.profileUrl),
    sourceUserId,
    userType: cleanText(input.userType, 30) || null,
    followersCount: Number.isFinite(followersCount) && followersCount >= 0 ? Math.floor(followersCount) : null,
    avatar: cleanText(input.avatar, 240) || null,
  };
}

async function addObservedCode(redis, { punter, bookingCode, booking, sourcePostId, sourceUrl, publishedAt, sourceText }) {
  const p = cleanPunterInput(punter);
  const code = String(bookingCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,24}$/.test(code)) throw new Error('invalid booking code');
  const capturedAt = nowIso();
  const combinedOdds = bookingCombinedOdds(booking);
  const firstKickoff = firstKickoffUtc(booking);
  const timing = timingStatus({ publishedAt, capturedAt, firstKickoff });
  const sourceId = cleanText(sourcePostId, 120) || null;
  const safeSourceUrl = p.source === 'x' ? validHttpUrl(sourceUrl, ['x.com','twitter.com'])
    : p.source === 'telegram' ? validHttpUrl(sourceUrl, ['t.me','telegram.me'])
    : p.source === 'sportysocial' ? validHttpUrl(sourceUrl, ['sportybet.com'])
    : validHttpUrl(sourceUrl);

  return mutateStore(redis, async store => {
    const existing = store.entries.find(x => x.punterId === p.id && x.bookingCode === code);
    if (existing) return { entry: existing, created: false };
    const seenPunter = store.punters[p.id];
    store.punters[p.id] = {
      ...(seenPunter || {}), ...p,
      firstSeenAt: seenPunter?.firstSeenAt || capturedAt,
      lastSeenAt: capturedAt,
    };
    const entry = {
      id: crypto.randomUUID(),
      punterId: p.id,
      source: p.source,
      bookingCode: code,
      sourcePostId: sourceId,
      sourceUrl: safeSourceUrl,
      publishedAt: asIso(publishedAt || capturedAt),
      publishedAtVerified: Boolean(publishedAt && sourceId),
      capturedAt,
      combinedOdds: combinedOdds ? Number(combinedOdds.toFixed(4)) : null,
      firstKickoffUtc: firstKickoff,
      rankingEligible: timing.eligible,
      timingVerified: timing.timingVerified,
      timingReason: timing.reason,
      status: 'pending',
      settledAt: null,
      lastCheckedAt: null,
      sourceTextHash: sourceText ? crypto.createHash('sha256').update(String(sourceText)).digest('hex') : null,
    };
    store.entries.push(entry);
    if (sourceId && !store.scannedSourceIds.includes(`${p.source}:${sourceId}`)) store.scannedSourceIds.push(`${p.source}:${sourceId}`);
    return { entry, created: true };
  });
}

function sanitizeSportySocialSelection(row = {}) {
  const out = {};
  const allow = [
    'eventId','product','homeTeamName','awayTeamName','tournamentName','sportName',
    'marketId','marketName','marketDesc','outcomeId','outcomeName','outcomeDesc','specifier',
    'odds','price','startTime','eventStartTime','eventTime','kickoffTime','kickOffTime','scheduledTime',
    'matchTime','startDate','eventDate','status'
  ];
  for (const k of allow) {
    if (row[k] === undefined || row[k] === null) continue;
    const v = row[k];
    if (typeof v === 'string') out[k] = cleanText(v, 180);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function sanitizeSportySocialCode(code = {}) {
  const shareCode = cleanText(code.shareCode, 24).toUpperCase();
  if (!/^[A-Z0-9_-]{4,24}$/.test(shareCode)) return null;
  const out = {
    shareCode,
    orderType: Number.isFinite(Number(code.orderType)) ? Number(code.orderType) : null,
    foldsAmount: Number.isFinite(Number(code.foldsAmount)) ? Number(code.foldsAmount) : null,
    totalOdds: Number.isFinite(Number(code.totalOdds)) ? Number(code.totalOdds) : null,
    userId: cleanText(code.userId, 100) || null,
    status: Number.isFinite(Number(code.status)) ? Number(code.status) : null,
    deadline: Number.isFinite(Number(code.deadline)) ? Number(code.deadline) : null,
    createTime: Number.isFinite(Number(code.createTime)) ? Number(code.createTime) : null,
    popularity: Number.isFinite(Number(code.popularity)) ? Number(code.popularity) : null,
    isBetBuilder: Boolean(code.isBetBuilder),
    source: Number.isFinite(Number(code.source)) ? Number(code.source) : null,
    shareCodeDetail: Array.isArray(code.shareCodeDetail) ? code.shareCodeDetail.slice(0, 40).map(sanitizeSportySocialSelection) : [],
  };
  return out;
}

async function importSportySocialBatch(redis, items = []) {
  if (!Array.isArray(items)) throw new Error('SportySocial items must be an array');
  const capped = items.slice(0, 500);
  const summary = { received: items.length, checked: 0, added: 0, duplicates: 0, originalsAdded: 0, repostsAdded: 0, unknownOriginAdded: 0, invalid: 0, errors: [] };

  for (const raw of capped) {
    summary.checked += 1;
    try {
      const code = sanitizeSportySocialCode(raw?.code || raw?.bookingCode || raw?.shareCode || {});
      const nickname = cleanText(raw?.nickname || raw?.username || raw?.displayName, 80);
      const sourceUserId = cleanText(raw?.userId || code?.userId, 100);
      if (!nickname || !sourceUserId || !code) { summary.invalid += 1; continue; }

      const createTime = Number(code.createTime);
      const publishedAt = Number.isFinite(createTime) && createTime > 0 ? new Date(createTime).toISOString() : null;
      const sourcePostId = publishedAt ? `sportysocial:${sourceUserId}:${code.shareCode}:${createTime}` : null;
      const profileUrl = `https://www.sportybet.com/ng/m/player/${encodeURIComponent(slug(nickname))}`;
      const result = await addObservedCode(redis, {
        punter: {
          source: 'sportysocial', username: nickname, displayName: nickname, profileUrl, sourceUserId,
          userType: raw?.userType, followersCount: raw?.followersCount, avatar: raw?.avatar,
        },
        bookingCode: code.shareCode,
        booking: code,
        sourcePostId,
        sourceUrl: profileUrl,
        publishedAt,
        sourceText: `${nickname}|${code.shareCode}|${code.totalOdds || ''}|${code.foldsAmount || ''}`,
      });
      if (result.created) {
        summary.added += 1;
        if (result.entry?.ownershipStatus === 'original') summary.originalsAdded += 1;
        else if (result.entry?.ownershipStatus === 'repost') summary.repostsAdded += 1;
        else summary.unknownOriginAdded += 1;
      } else summary.duplicates += 1;
    } catch (e) {
      summary.errors.push({ message: cleanText(e.message, 120) });
    }
  }
  summary.errors = summary.errors.slice(0, 20);
  return summary;
}

function scoreStats(stats) {
  if (!stats.settled) return 0;
  // Conservative Bayesian win rate prevents a 1/1 account from topping the table.
  const bayesWin = ((stats.wins + 2) / (stats.settled + 4)) * 100;
  const roiScore = Math.max(0, Math.min(100, 50 + (stats.roiPct / 2)));
  const sampleScore = Math.min(100, (stats.settled / 25) * 100);
  const activityScore = stats.lastPublishedAt && Date.now() - new Date(stats.lastPublishedAt).getTime() <= 7 * 86400000 ? 100 : 40;
  return Math.round((bayesWin * 0.45 + roiScore * 0.35 + sampleScore * 0.15 + activityScore * 0.05) * 10) / 10;
}
function buildLeaderboard(store, { days = 30, limit = 50, source = 'all' } = {}) {
  const cutoff = Date.now() - Math.max(1, Math.min(365, Number(days) || 30)) * 86400000;
  const grouped = new Map();
  for (const e of store.entries || []) {
    if (new Date(e.publishedAt || e.capturedAt).getTime() < cutoff) continue;
    if (source !== 'all' && e.source !== source) continue;
    if (!e.rankingEligible) continue;
    if (e.ownershipStatus !== 'original' || !e.ownershipRankingEligible) continue;
    const p = store.punters[e.punterId];
    if (!p) continue;
    if (!grouped.has(e.punterId)) grouped.set(e.punterId, { punter: p, codes: 0, settled: 0, wins: 0, losses: 0, pushes: 0, pending: 0, profitUnits: 0, roiSamples: 0, oddsSum: 0, oddsCount: 0, timingVerifiedCodes: 0, lastPublishedAt: null, latestCode: null, latestStatus: null });
    const s = grouped.get(e.punterId);
    s.codes += 1;
    if (e.timingVerified) s.timingVerifiedCodes += 1;
    if (e.combinedOdds) { s.oddsSum += Number(e.combinedOdds); s.oddsCount += 1; }
    const t = new Date(e.publishedAt || e.capturedAt).getTime();
    if (!s.lastPublishedAt || t > new Date(s.lastPublishedAt).getTime()) {
      s.lastPublishedAt = e.publishedAt || e.capturedAt;
      s.latestCode = e.bookingCode;
      s.latestStatus = e.status;
    }
    if (e.status === 'won') { s.settled += 1; s.wins += 1; if (Number(e.combinedOdds) > 1) { s.profitUnits += Number(e.combinedOdds) - 1; s.roiSamples += 1; } }
    else if (e.status === 'lost') { s.settled += 1; s.losses += 1; if (Number(e.combinedOdds) > 1) { s.profitUnits -= 1; s.roiSamples += 1; } }
    else if (e.status === 'push') { s.settled += 1; s.pushes += 1; if (Number(e.combinedOdds) > 1) s.roiSamples += 1; }
    else s.pending += 1;
  }
  const rows = [...grouped.values()].map(s => {
    const winRate = s.settled ? (s.wins / s.settled) * 100 : 0;
    const roiPct = s.roiSamples ? (s.profitUnits / s.roiSamples) * 100 : 0;
    const avgOdds = s.oddsCount ? s.oddsSum / s.oddsCount : null;
    const row = { ...s, winRate, roiPct, avgOdds };
    row.copyScore = scoreStats(row);
    return row;
  }).sort((a,b) => b.copyScore - a.copyScore || b.profitUnits - a.profitUnits || b.settled - a.settled);
  return rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 50))).map((x, i) => ({ rank: i + 1, ...x }));
}

function xPostSignals(text) {
  const src = String(text || '');
  const lower = src.toLowerCase();
  const signals = {
    sportybet: /\bsporty\s*bet\b/i.test(src) || /\bsportybet\b/i.test(src),
    bookingCode: /\bbooking\s+code\b/i.test(src),
    codeWord: /\b(?:sporty\s+code|bet\s+code|code)\b/i.test(src),
    boom: /\bbo+m+\b/i.test(src),
    odds: /\bodds?\b/i.test(src),
    ticket: /\b(?:ticket|slip|betslip)\b/i.test(src),
    tail: /\b(?:tail|copy|copied)\b/i.test(src),
    result: /\b(?:won|win|landed|cashout|cash\s*out)\b/i.test(src),
    bet: /\bbet(?:ting)?\b/i.test(src),
    shareUrl: /(?:shareCode=|\/orders\/share\/)[A-Za-z0-9_-]{4,24}/i.test(src),
  };
  signals.bettingContext = signals.sportybet || signals.bookingCode || signals.odds || signals.ticket || signals.tail || signals.bet;
  signals.lower = lower;
  return signals;
}

function xPostRelevanceScore(text, candidates = null) {
  const sig = xPostSignals(text);
  const codes = Array.isArray(candidates) ? candidates : extractBookingCodeCandidates(text);
  let score = 0;
  if (codes.length) score += 5;
  if (sig.sportybet) score += 3;
  if (sig.bookingCode) score += 2;
  if (sig.boom) score += 2;
  if (sig.odds) score += 1;
  if (sig.ticket) score += 1;
  if (sig.tail) score += 1;
  if (sig.result) score += 1;
  if (sig.shareUrl) score += 3;
  return score;
}

function extractBookingCodeCandidates(text) {
  const src = String(text || '');
  const out = [];
  const add = v => {
    const x = String(v || '').trim().toUpperCase();
    if (/^[A-Z0-9_-]{4,24}$/.test(x) && !out.includes(x)) out.push(x);
  };

  // Strongest signal: a SportyBet share URL or explicit code label.
  const shareUrl = /(?:[?&]shareCode=|\/orders\/share\/)([A-Za-z0-9_-]{4,24})/ig;
  let m;
  while ((m = shareUrl.exec(src))) add(m[1]);

  const contextual = /(?:sporty(?:\s*bet)?(?:\s+booking)?\s+code|booking\s+code|bet\s+code|sporty\s+code|code)\s*(?:is|[:=\-–—])?\s*#?([A-Za-z0-9_-]{4,24})/ig;
  while ((m = contextual.exec(src))) add(m[1]);

  // Nigerian punters often post "BOOM" with odds/ticket/slip language and then drop
  // the code without explicitly writing "booking code". In that case, infer only
  // mixed alpha-numeric tokens to avoid validating ordinary numbers, odds and dates.
  const sig = xPostSignals(src);
  const inferLoose = sig.sportybet || (sig.boom && (sig.odds || sig.ticket || sig.tail || sig.bet || sig.result));
  if (inferLoose) {
    const caps = src.match(/\b[A-Z0-9]{5,10}\b/g) || [];
    const deny = new Set(['SPORTYBET','SPORTY','BOOM','BOOOOM','BOOKING','TICKET','BETSLIP','CASHOUT']);
    for (const c of caps) {
      const upper = c.toUpperCase();
      if (deny.has(upper)) continue;
      // Inferred candidates must contain at least one letter and one number.
      if (/[A-Z]/.test(upper) && /\d/.test(upper)) add(upper);
    }
  }
  return out.slice(0, 4);
}

function defaultXCopyQueries() {
  return [
    '(SportyBet OR "Sporty Bet" OR "SportyBet code" OR "Sporty code" OR "booking code") -is:retweet',
    'boom (SportyBet OR "booking code" OR "Sporty code" OR bet OR odds OR ticket OR slip OR tail) -is:retweet',
  ];
}

function resolveXCopyQueries(query) {
  const supplied = Array.isArray(query) ? query : (query ? [query] : []);
  const cleanedSupplied = supplied.map(q => cleanText(q, 500)).filter(Boolean);
  if (cleanedSupplied.length) return [...new Set(cleanedSupplied)].slice(0, 5);

  if (process.env.X_COPY_QUERIES_JSON) {
    try {
      const parsed = JSON.parse(process.env.X_COPY_QUERIES_JSON);
      if (Array.isArray(parsed)) {
        const xs = parsed.map(q => cleanText(q, 500)).filter(Boolean);
        if (xs.length) return [...new Set(xs)].slice(0, 5);
      }
    } catch {}
  }
  if (process.env.X_COPY_QUERY) return [cleanText(process.env.X_COPY_QUERY, 500)].filter(Boolean);
  return defaultXCopyQueries();
}

async function fetchXRecentQuery(token, q, max) {
  const u = new URL('https://api.x.com/2/tweets/search/recent');
  u.searchParams.set('query', q);
  u.searchParams.set('max_results', String(max));
  u.searchParams.set('tweet.fields', 'author_id,created_at,public_metrics');
  u.searchParams.set('expansions', 'author_id');
  u.searchParams.set('user.fields', 'username,name,verified');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(u, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: controller.signal });
  } finally { clearTimeout(timer); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload?.detail || payload?.title || `X API HTTP ${response.status}`);
    err.code = 'X_API_FAILED';
    err.status = response.status;
    err.query = q;
    throw err;
  }
  return payload;
}

async function scanXRecent({ redis, getBooking, query, maxResults = 25 }) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    const err = new Error('X_BEARER_TOKEN is not configured');
    err.code = 'X_NOT_CONFIGURED';
    throw err;
  }

  const store = await readStore(redis);
  const queries = resolveXCopyQueries(query);
  const max = Math.max(10, Math.min(100, Number(maxResults) || 25));
  const users = new Map();
  const postsById = new Map();
  const queryStats = [];

  // Multiple targeted searches broaden discovery while we deduplicate overlapping posts
  // before any SportyBet validation calls are made.
  for (const q of queries) {
    const payload = await fetchXRecentQuery(token, q, max);
    const qPosts = Array.isArray(payload?.data) ? payload.data : [];
    for (const u of (payload?.includes?.users || [])) users.set(String(u.id), u);
    for (const post of qPosts) {
      const id = String(post.id || '');
      if (!id) continue;
      const current = postsById.get(id);
      if (!current) postsById.set(id, { ...post, matchedQueries: [q] });
      else if (!current.matchedQueries.includes(q)) current.matchedQueries.push(q);
    }
    queryStats.push({ query: q, postsReturned: qPosts.length });
  }

  const seen = new Set(store.scannedSourceIds || []);
  const newPosts = [];
  let postsChecked = 0;

  for (const post of postsById.values()) {
    const sourceKey = `x:${post.id}`;
    if (seen.has(sourceKey)) continue;
    postsChecked += 1;
    const codes = extractBookingCodeCandidates(post.text);
    const score = xPostRelevanceScore(post.text, codes);
    if (!codes.length) {
      await mutateStore(redis, async s => { if (!s.scannedSourceIds.includes(sourceKey)) s.scannedSourceIds.push(sourceKey); });
      continue;
    }
    newPosts.push({ post, codes, score, sourceKey });
  }

  // Validate high-signal posts first: real code patterns, SportyBet references, BOOM + odds,
  // ticket/slip language, etc. Recent timestamp breaks ties.
  newPosts.sort((a, b) => b.score - a.score || new Date(b.post.created_at || 0) - new Date(a.post.created_at || 0));

  let candidates = 0, added = 0, originalsAdded = 0, repostsAdded = 0, unknownOriginAdded = 0, invalid = 0, duplicates = 0;
  const errors = [];
  const maxValidations = Math.max(1, Math.min(50, parseInt(process.env.X_COPY_MAX_VALIDATIONS || '12', 10)));
  let validations = 0;
  let candidatePosts = 0;

  for (const item of newPosts) {
    if (validations >= maxValidations) break;
    candidatePosts += 1;
    const { post, codes, sourceKey } = item;
    const user = users.get(String(post.author_id)) || {};
    const username = user.username || `x_${post.author_id}`;
    let attemptedAll = true;

    for (const code of codes) {
      candidates += 1;
      if (validations >= maxValidations) { attemptedAll = false; break; }
      validations += 1;
      try {
        const booking = await getBooking(code);
        const r = await addObservedCode(redis, {
          punter: { source: 'x', username, displayName: user.name || username, sourceUserId: post.author_id, profileUrl: `https://x.com/${username}` },
          bookingCode: code,
          booking,
          sourcePostId: post.id,
          sourceUrl: `https://x.com/${username}/status/${post.id}`,
          publishedAt: post.created_at,
          sourceText: post.text,
        });
        if (r.created) {
          added += 1;
          if (r.entry?.ownershipStatus === 'original') originalsAdded += 1;
          else if (r.entry?.ownershipStatus === 'repost') repostsAdded += 1;
          else unknownOriginAdded += 1;
        } else duplicates += 1;
      } catch (e) {
        invalid += 1;
        if (errors.length < 8) errors.push({ code, username, message: cleanText(e.message, 140) });
      }
    }

    // Only mark a candidate post fully scanned when every extracted code was attempted.
    // This lets lower-priority candidates roll over to the next twice-daily run when the
    // validation budget is reached.
    if (attemptedAll) {
      await mutateStore(redis, async s => { if (!s.scannedSourceIds.includes(sourceKey)) s.scannedSourceIds.push(sourceKey); });
    }
  }

  return {
    queries,
    queryStats,
    uniquePostsReturned: postsById.size,
    postsChecked,
    candidatePosts,
    candidates,
    validations,
    added,
    originalsAdded,
    repostsAdded,
    unknownOriginAdded,
    duplicates,
    invalid,
    errors,
    discoveryMode: 'broad-sportybet-plus-boom',
  };
}

async function settlePending({ redis, getBooking, evaluateBooking, maxChecks = 20 }) {
  const store = await readStore(redis);
  const byCode = new Map();
  for (const entry of (store.entries || []).filter(x => x.status === 'pending')) {
    const current = byCode.get(entry.bookingCode);
    if (!current || (entry.ownershipStatus === 'original' && current.ownershipStatus !== 'original')) byCode.set(entry.bookingCode, entry);
  }
  const pending = [...byCode.values()].slice(0, Math.max(1, Math.min(100, Number(maxChecks) || 20)));
  let checked = 0, settled = 0;
  const updates = [];
  for (const entry of pending) {
    try {
      const booking = await getBooking(entry.bookingCode);
      const evaluated = evaluateBooking(booking);
      const status = ['won','lost','push'].includes(evaluated.status) ? evaluated.status : 'pending';
      const checkedAt = nowIso();
      await mutateStore(redis, async s => {
        const rows = s.entries.filter(x => x.bookingCode === entry.bookingCode);
        for (const row of rows) {
          row.lastCheckedAt = checkedAt;
          if (status !== 'pending') { row.status = status; row.settledAt = checkedAt; }
        }
      });
      checked += 1;
      if (status !== 'pending') settled += 1;
      updates.push({ bookingCode: entry.bookingCode, status, copiesUpdated: (store.entries || []).filter(x => x.bookingCode === entry.bookingCode).length });
    } catch (e) {
      checked += 1;
      updates.push({ bookingCode: entry.bookingCode, status: 'error', error: cleanText(e.message, 100) });
    }
  }
  return { pendingFound: byCode.size, checked, settled, updates };
}

async function getPunterProfile(redis, id, days = 90) {
  const store = await readStore(redis);
  const p = store.punters[id];
  if (!p) return null;
  const cutoff = Date.now() - Math.max(1, Math.min(365, Number(days) || 90)) * 86400000;
  const entries = store.entries.filter(x => x.punterId === id && new Date(x.publishedAt || x.capturedAt).getTime() >= cutoff)
    .sort((a,b) => new Date(b.publishedAt || b.capturedAt) - new Date(a.publishedAt || a.capturedAt));
  const stats = buildLeaderboard({ ...store, entries }, { days, limit: 100, source: 'all' }).find(x => x.punter.id === id) || null;
  return { punter: p, stats, entries: entries.slice(0, 100) };
}

module.exports = {
  readStore,
  addObservedCode,
  importSportySocialBatch,
  buildLeaderboard,
  extractBookingCodeCandidates,
  scanXRecent,
  settlePending,
  getPunterProfile,
};
