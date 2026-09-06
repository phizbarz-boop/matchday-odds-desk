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
function punterId(source, username) {
  const base = `${normalizeSource(source)}:${slug(username) || 'unknown'}`;
  return `${normalizeSource(source)}_${crypto.createHash('sha256').update(base).digest('hex').slice(0, 14)}`;
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
  if (src === 'sportysocial') return validHttpUrl(supplied, ['sportybet.com']);
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
    for (const key of ['outcomes', 'selections', 'bets', 'items']) {
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
  const keys = ['kickoffUtc','kickoff_utc','kickoff','startTime','start_time','eventTime','event_time','matchTime','match_time','startDate','start_date'];
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
  const id = punterId(source, username);
  return {
    id,
    source,
    username,
    displayName: cleanText(input.displayName || input.name || username, 100),
    profileUrl: safeProfileUrl(source, username, input.profileUrl),
    sourceUserId: cleanText(input.sourceUserId, 100) || null,
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

function extractBookingCodeCandidates(text) {
  const src = String(text || '');
  const out = [];
  const add = v => { const x = String(v || '').toUpperCase(); if (/^[A-Z0-9_-]{4,24}$/.test(x) && !out.includes(x)) out.push(x); };
  const contextual = /(?:sporty(?:bet)?(?:\s+booking)?\s+code|booking\s+code|bet\s+code|code)\s*(?:is|[:=\-–—])?\s*#?([A-Za-z0-9_-]{4,24})/ig;
  let m;
  while ((m = contextual.exec(src))) add(m[1]);
  if (/sportybet/i.test(src)) {
    const caps = src.match(/\b[A-Z0-9]{5,10}\b/g) || [];
    for (const c of caps) if (/\d/.test(c)) add(c);
  }
  return out.slice(0, 3);
}

async function scanXRecent({ redis, getBooking, query, maxResults = 25 }) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    const err = new Error('X_BEARER_TOKEN is not configured');
    err.code = 'X_NOT_CONFIGURED';
    throw err;
  }
  const store = await readStore(redis);
  const q = cleanText(query || process.env.X_COPY_QUERY || '(SportyBet OR "SportyBet code" OR "booking code") -is:retweet', 500);
  const max = Math.max(10, Math.min(100, Number(maxResults) || 25));
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
    throw err;
  }
  const users = new Map((payload?.includes?.users || []).map(x => [String(x.id), x]));
  const posts = Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set(store.scannedSourceIds || []);
  let postsChecked = 0, candidates = 0, added = 0, originalsAdded = 0, repostsAdded = 0, unknownOriginAdded = 0, invalid = 0, duplicates = 0;
  const errors = [];
  const maxValidations = Math.max(1, Math.min(25, parseInt(process.env.X_COPY_MAX_VALIDATIONS || '12', 10)));
  let validations = 0;
  for (const post of posts) {
    const sourceKey = `x:${post.id}`;
    if (seen.has(sourceKey)) continue;
    postsChecked += 1;
    const codes = extractBookingCodeCandidates(post.text);
    if (!codes.length) {
      await mutateStore(redis, async s => { if (!s.scannedSourceIds.includes(sourceKey)) s.scannedSourceIds.push(sourceKey); });
      continue;
    }
    const user = users.get(String(post.author_id)) || {};
    const username = user.username || `x_${post.author_id}`;
    for (const code of codes) {
      candidates += 1;
      if (validations >= maxValidations) break;
      validations += 1;
      try {
        const booking = await getBooking(code); // validation happens through the existing SportyBet adapter
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
        if (errors.length < 5) errors.push({ code, message: cleanText(e.message, 140) });
      }
    }
    await mutateStore(redis, async s => { if (!s.scannedSourceIds.includes(sourceKey)) s.scannedSourceIds.push(sourceKey); });
    if (validations >= maxValidations) break;
  }
  return { query: q, postsReturned: posts.length, postsChecked, candidates, validations, added, originalsAdded, repostsAdded, unknownOriginAdded, duplicates, invalid, errors };
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
  buildLeaderboard,
  extractBookingCodeCandidates,
  scanXRecent,
  settlePending,
  getPunterProfile,
};
