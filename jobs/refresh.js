// SportyBet-only daily fixture, statistics and market refresh.
const fs = require('fs');
const path = require('path');
const { getFootballMarket, getSportMarket } = require('../lib/sportybet');
const { enrichSportyFixtures, cleanPredictions, MODEL_VERSION } = require('../lib/sportyFootballModel');

// Keep enough model fixtures for the Analyzer without forcing the normal SportyBet Auto Builder to scan the same horizon.
const ANALYZER_DAYS = Math.max(7, Math.min(21, parseInt(process.env.ANALYZER_DAYS || '14', 10)));
const DAYS_AHEAD = Math.max(parseInt(process.env.DAYS_AHEAD || '4', 10), parseInt(process.env.PREDICTION_DAYS_AHEAD || '21', 10));
const H2H_MAX_WEIGHT = Math.max(0, Math.min(0.35, parseFloat(process.env.H2H_MAX_WEIGHT || '0.18')));
const DATA_FILE = path.join(__dirname, '..', 'data', 'predictions.json');

// Snapshot keys/files must match server.js exactly: the web process reads what
// this job writes. File snapshots matter when REDIS_URL is not set — the refresh
// job runs as a separate process and would otherwise be invisible to the server.
const SNAPSHOT_DIR = path.join(__dirname, '..', 'data', 'sporty-snapshots');

function sportySnapshotKey(sport, kind) {
  const teamGoal = sport === 'football' && ['home_ou05','away_ou05','home_ou45','away_ou45'].includes(kind);
  const v = String(process.env.SPORTYBET_CACHE_VERSION || '9') + (teamGoal ? '-ng-team-v2' : '');
  return `sportybet:snapshot:v${v}:${sport}:${kind}`;
}

function writeSnapshotFile(key, snapshot) {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SNAPSHOT_DIR, key.replace(/[^a-zA-Z0-9]+/g, '_') + '.json'), JSON.stringify(snapshot));
  } catch (err) {
    console.warn(`Snapshot file write failed for ${key}: ${err.message}`);
  }
}

// Fetch every Auto Builder market for all six sports once per daily refresh and
// store the payloads as shared snapshots. The prematch list request embeds every
// configured market (marketId CSV), so all football kinds reuse the same cached
// pages — seeding a whole sport costs about maxPages list requests, not one
// request per market. These snapshots support background jobs and daily status;
// user-requested builds and analyses read current SportyBet data independently.
async function collectSportySnapshots({ hours, maxPages, fixtures }) {
  const snapshots = [];
  const add = (sport, kind, payload) => {
    if (payload && Array.isArray(payload.rows) && payload.rows.length) {
      snapshots.push({ sport, kind, hours, payload });
      console.log(`Snapshot collected ${sport}/${kind}: ${payload.rows.length} rows`);
    } else {
      console.warn(`Snapshot skipped ${sport}/${kind}: no rows returned`);
    }
  };
  const footballKinds = ['1x2','gg','dc','dnb','ou05','ou15','ou45','ou25','cs','ah','corners'];
  for (const kind of footballKinds) {
    try { add('football', kind, await getFootballMarket(kind, { hours, maxPages })); }
    catch (err) { console.warn(`Snapshot seed football/${kind} failed: ${err.message}`); }
  }
  // Team-goal markets use bounded per-event detail scans against the saved fixtures.
  for (const kind of ['home_ou05','away_ou05','home_ou45','away_ou45']) {
    try { add('football', kind, await getFootballMarket(kind, { hours, maxPages, fixtures })); }
    catch (err) { console.warn(`Snapshot seed football/${kind} failed: ${err.message}`); }
  }
  const otherSports = {
    basketball: ['winner','totals','handicap'],
    hockey: ['winner','totals','handicap'],
    handball: ['winner','totals','handicap'],
    volleyball: ['winner','totals','sets','handicap'],
    tennis: ['winner','totals','handicap'],
  };
  for (const [sport, kinds] of Object.entries(otherSports)) {
    for (const kind of kinds) {
      try { add(sport, kind, await getSportMarket(sport, kind, { hours, maxPages })); }
      catch (err) { console.warn(`Snapshot seed ${sport}/${kind} failed: ${err.message}`); }
    }
  }
  return snapshots;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function pickLabel(p) {
  if (p.homeWin >= p.draw && p.homeWin >= p.awayWin) return 'Home Win';
  if (p.awayWin >= p.draw) return 'Away Win';
  return 'Draw';
}

function predictionCacheKey(row) {
  const eventId = String(row?.sportyEventId || row?.eventId || '').trim();
  if (eventId) return `event:${eventId}`;
  const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const day = String(row?.kickoffUtc || '').slice(0, 10);
  return `fixture:${norm(row?.home)}|${norm(row?.away)}|${day}`;
}

function isFutureFixture(row, nowMs = Date.now()) {
  const kickoffMs = Date.parse(row?.kickoffUtc || '');
  return Number.isFinite(kickoffMs) && kickoffMs > nowMs;
}

function hasUsablePrediction(row) {
  const fields = ['h', 'd', 'a', 'btts', 'o05', 'o15', 'u45', 'o25', 'pickProb'];
  return fields.some(field => Number(row?.[field]) > 0);
}

function mergeWithExistingPredictions(freshPayload, previousPayload) {
  const fresh = Array.isArray(freshPayload?.matches) ? freshPayload.matches : [];
  const previous = cleanPredictions(previousPayload).matches;
  const previousByKey = new Map(previous.map(row => [predictionCacheKey(row), row]));
  const freshKeys = new Set();
  const merged = [];
  let restoredGoodModel = 0;
  let carriedForward = 0;
  let expiredDropped = 0;
  const nowMs = Date.now();

  for (const row of fresh) {
    const key = predictionCacheKey(row);
    freshKeys.add(key);
    const old = previousByKey.get(key);

    if (old && isFutureFixture(row, nowMs) && hasUsablePrediction(old) && !hasUsablePrediction(row)) {
      merged.push({
        ...old,
        home: row.home || old.home,
        away: row.away || old.away,
        league: row.league || old.league,
        leagueCode: row.leagueCode || old.leagueCode,
        kickoffUtc: row.kickoffUtc || old.kickoffUtc,
        eventId: row.eventId || old.eventId,
        sportyEventId: row.sportyEventId || old.sportyEventId,
        cacheCarryForward: true,
        cacheCarryForwardReason: 'fresh_fixture_had_no_usable_model',
      });
      restoredGoodModel++;
    } else {
      merged.push(row);
    }
  }

  for (const old of previous) {
    const key = predictionCacheKey(old);
    if (freshKeys.has(key)) continue;
    if (!isFutureFixture(old, nowMs)) {
      expiredDropped++;
      continue;
    }
    if (!hasUsablePrediction(old)) continue;
    merged.push({
      ...old,
      cacheCarryForward: true,
      cacheCarryForwardReason: 'missing_from_latest_refresh',
    });
    carriedForward++;
  }

  return {
    ...freshPayload,
    matches: merged,
    cacheMerge: {
      previousCount: previous.length,
      freshCount: fresh.length,
      finalCount: merged.length,
      restoredGoodModel,
      carriedForward,
      expiredDropped,
      mergedAt: new Date().toISOString(),
    },
  };
}

async function storeResult(payload, marketSnapshots = []) {
  if (process.env.REDIS_URL) {
    const { createClient } = require('redis');
    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();

    let finalPayload = payload;
    try {
      const previousRaw = await client.get('predictions:latest');
      const previousPayload = previousRaw ? JSON.parse(previousRaw) : null;
      finalPayload = mergeWithExistingPredictions(payload, previousPayload);
      const m = finalPayload.cacheMerge || {};
      console.log(
        `Prediction cache merge: fresh=${m.freshCount || 0}, previous=${m.previousCount || 0}, ` +
        `restored=${m.restoredGoodModel || 0}, carried=${m.carriedForward || 0}, final=${m.finalCount || 0}`
      );
    } catch (err) {
      console.warn(`Prediction cache merge skipped: ${err.message}`);
    }

    await client.set('predictions:latest', JSON.stringify(finalPayload));

    // Seed the shared SportyBet daily snapshot cache from this refresh.
    // User-requested builds bypass these snapshots for current market availability.
    const snapshotTtl = Math.max(3600, parseInt(process.env.SPORTYBET_DAILY_SNAPSHOT_SECONDS || '93600', 10));
    for (const snap of marketSnapshots) {
      if (!snap?.payload || !Array.isArray(snap.payload.rows) || !snap.payload.rows.length) continue;
      const key = sportySnapshotKey(snap.sport, snap.kind);
      const value = { ...snap.payload, snapshotHours:Number(snap.hours)||0, snapshotSavedAt:new Date().toISOString() };
      await client.set(key, JSON.stringify(value), { EX: snapshotTtl });
      // Disk copy too: harmless with Redis, and covers a web process without it.
      writeSnapshotFile(key, value);
      console.log(`Seeded daily SportyBet snapshot ${snap.sport}/${snap.kind}: ${snap.payload.rows.length} rows`);
    }

    await client.quit();
    console.log('Wrote predictions to Redis key "predictions:latest"');
  } else {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    let finalPayload = payload;
    try {
      const previousPayload = fs.existsSync(DATA_FILE)
        ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
        : null;
      finalPayload = mergeWithExistingPredictions(payload, previousPayload);
    } catch (err) {
      console.warn(`Local prediction cache merge skipped: ${err.message}`);
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(finalPayload, null, 2));
    // No Redis: file snapshots are the only channel from this job process to the
    // web process, so they are mandatory here, not optional.
    for (const snap of marketSnapshots) {
      if (!snap?.payload || !Array.isArray(snap.payload.rows) || !snap.payload.rows.length) continue;
      const key = sportySnapshotKey(snap.sport, snap.kind);
      writeSnapshotFile(key, { ...snap.payload, snapshotHours:Number(snap.hours)||0, snapshotSavedAt:new Date().toISOString() });
      console.log(`Seeded daily SportyBet snapshot file ${snap.sport}/${snap.kind}: ${snap.payload.rows.length} rows`);
    }
    console.log(`Wrote predictions to ${DATA_FILE} (no REDIS_URL set)`);
  }
}

async function main() {
  let redis;
  try{
    if(process.env.REDIS_URL){redis=require('redis').createClient({url:process.env.REDIS_URL});redis.on('error',()=>{});await redis.connect();}
    const cache=require('../lib/sportyPublicCache').createPublicCache({getRedis:async()=>redis||null});
    const result=await cache.refresh();
    const sports=result.catalog?.sports||{};
    console.log(`Public SportyBet cache saved: ${Object.values(sports).reduce((n,data)=>n+data.fixtures.length,0)} fixtures across ${Object.keys(sports).length} sports; no dummy login used.`);
  }finally{if(redis?.isOpen)await redis.quit();}
}

if (require.main === module) main().catch(err=>{console.error(err.message);process.exitCode=1;});
module.exports = {main, mergeWithExistingPredictions, collectSportySnapshots};
