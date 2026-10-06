'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildCandidates } = require('../lib/autoPicker');
const { buildRowsFromOdds, appendUncoveredRows, buildCornerModelsByEvent, invertPoissonOver } = require('../lib/sportyOddsModel');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const refreshSrc = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'refresh.js'), 'utf8');

const KO = '2026-10-07T15:00:00Z';
const ou = (eventId, home, away, line, overOdds, underOdds, marketDesc = 'Over/Under', marketId = '18') => ([
  { eventId, home, away, marketId, marketDesc, outcomeId: '12', outcomeDesc: 'Over', odds: overOdds, specifier: `total=${line}` },
  { eventId, home, away, marketId, marketDesc, outcomeId: '13', outcomeDesc: 'Under', odds: underOdds, specifier: `total=${line}` },
]);
const oneXtwo = (eventId, home, away, ho, do_, ao, extra = {}) => ([
  { eventId, home, away, marketId: '1', marketDesc: '1X2', outcomeId: '1', outcomeDesc: 'Home', odds: ho, specifier: null, ...extra },
  { eventId, home, away, marketId: '1', marketDesc: '1X2', outcomeId: 'X', outcomeDesc: 'Draw', odds: do_, specifier: null, ...extra },
  { eventId, home, away, marketId: '1', marketDesc: '1X2', outcomeId: '2', outcomeDesc: 'Away', odds: ao, specifier: null, ...extra },
]);

// --- SportyBet odds model: field derivation ----------------------------------

test('odds model de-vigs 1X2, GG/NG, goal lines, correct score and corners from SportyBet rows', () => {
  const rows = [
    ...oneXtwo('sr:match:m1', 'Arsenal', 'Chelsea', 2.0, 3.4, 3.8),
    { eventId: 'sr:match:m1', home: 'Arsenal', away: 'Chelsea', marketId: '29', marketDesc: 'GG/NG', outcomeId: '1', outcomeDesc: 'GG', odds: 1.95, specifier: null },
    { eventId: 'sr:match:m1', home: 'Arsenal', away: 'Chelsea', marketId: '29', marketDesc: 'GG/NG', outcomeId: '2', outcomeDesc: 'NG', odds: 1.85, specifier: null },
    ...ou('sr:match:m1', 'Arsenal', 'Chelsea', 0.5, 1.05, 9.0),
    ...ou('sr:match:m1', 'Arsenal', 'Chelsea', 1.5, 1.30, 3.4),
    ...ou('sr:match:m1', 'Arsenal', 'Chelsea', 2.5, 2.10, 1.70),
    ...ou('sr:match:m1', 'Arsenal', 'Chelsea', 4.5, 5.5, 1.12),
    ...ou('sr:match:m1', 'Arsenal', 'Chelsea', 0.5, 1.22, 4.0, 'Home Total', '45'),
    { eventId: 'sr:match:m1', home: 'Arsenal', away: 'Chelsea', marketId: '200', marketDesc: 'Correct Score', outcomeId: '1', outcomeDesc: '1-0', odds: 7.0, specifier: null },
    { eventId: 'sr:match:m1', home: 'Arsenal', away: 'Chelsea', marketId: '200', marketDesc: 'Correct Score', outcomeId: '2', outcomeDesc: '2-1', odds: 8.5, specifier: null },
    { eventId: 'sr:match:m1', home: 'Arsenal', away: 'Chelsea', marketId: '200', marketDesc: 'Correct Score', outcomeId: '3', outcomeDesc: '0-0', odds: 11.0, specifier: null },
    ...ou('sr:match:m1', 'Arsenal', 'Chelsea', 9.5, 1.90, 1.90, 'Over/Under Corners', '300'),
  ].map(r => ({ kickoffUtc: KO, tournament: 'PL', ...r }));
  const out = buildRowsFromOdds([{ rows }]);
  assert.equal(out.length, 1);
  const r = out[0];
  // 1X2 no-vig: 1/2.0 + 1/3.4 + 1/3.8 = 1.057 -> 47/28/25
  assert.deepEqual([r.h, r.d, r.a], [47, 28, 25]);
  assert.equal(r.btts, 49);
  assert.equal(r.o05, 90);
  assert.equal(r.o15, 72);
  assert.equal(r.o25, 45);
  assert.equal(r.u45, 83);
  assert.equal(r.homeO05, 77);
  assert.equal(r.awayO05, null, 'absent markets stay null, never zero');
  assert.equal(r.score, '1-0');
  assert.ok(r.scoreP > 30 && r.scoreP < 50);
  assert.ok(Math.abs(r.corners.totalLambda - 9.67) < 0.1, 'a 50/50 9.5 corners line inverts to lambda ~9.67');
  assert.equal(r.dataSource, 'SportyBet odds (no-vig)');
  assert.equal(r.pick, 'Home Win');
});

test('odds model never produces a row without a de-viggable 1X2 market', () => {
  const rows = [
    { eventId: 'sr:match:m2', home: 'NoOdds FC', away: 'Zero United', kickoffUtc: KO, marketId: '29', marketDesc: 'GG/NG', outcomeId: '1', outcomeDesc: 'GG', odds: 2.0, specifier: null },
  ];
  assert.equal(buildRowsFromOdds([{ rows }]).length, 0);
});

test('odds model splits live and prematch rows strictly by the live flag', () => {
  const liveRows = oneXtwo('sr:match:m3', 'Live FC', 'Real Test', 1.8, 3.5, 4.5, { live: true }).map(r => ({ kickoffUtc: KO, ...r }));
  const preRows = oneXtwo('sr:match:m4', 'Pre FC', 'Future United', 2.2, 3.2, 3.4).map(r => ({ kickoffUtc: KO, ...r }));
  const live = buildRowsFromOdds([{ rows: [...liveRows, ...preRows] }], { live: true });
  assert.equal(live.length, 1);
  assert.equal(live[0].home, 'Live FC');
  assert.equal(live[0].live, true);
  assert.equal(live[0].dataSource, 'SportyBet live odds (no-vig)');
  const pre = buildRowsFromOdds([{ rows: [...liveRows, ...preRows] }], { live: false });
  assert.equal(pre.length, 1);
  assert.equal(pre[0].home, 'Pre FC');
});

test('appendUncoveredRows never displaces an existing Poisson + H2H row', () => {
  const existing = [{ eventId: 'sr:match:m5', home: 'Arsenal', away: 'Chelsea', kickoffUtc: KO, h: 60, d: 22, a: 18, dataSource: 'football-data.org' }];
  const oddsRows = buildRowsFromOdds([{ rows: oneXtwo('sr:match:m5', 'Arsenal', 'Chelsea', 2.0, 3.4, 3.8).map(r => ({ kickoffUtc: KO, ...r })) }]);
  const res = appendUncoveredRows(existing, oddsRows);
  assert.equal(res.stats.added, 0);
  assert.equal(res.stats.alreadyCovered, 1);
  assert.equal(res.matches[0].h, 60, 'the saved model row stays authoritative');
});

test('corner models attach from corner-market rows alone (no 1X2 required)', () => {
  const cornerRows = [
    ...ou('sr:match:m6', 'Corner FC', 'Flag United', 10.5, 1.85, 1.95, 'Over/Under Corners', '300'),
  ].map(r => ({ kickoffUtc: KO, ...r }));
  const map = buildCornerModelsByEvent([{ rows: cornerRows }]);
  const model = map.get('sr:match:m6');
  assert.ok(model, 'corner model derived without any 1X2 rows');
  assert.ok(model.totalLambda > 9 && model.totalLambda < 12);
  assert.ok(model.firstHalfHomeLambda > 0 && model.firstHalfAwayLambda > 0);
});

test('invertPoissonOver round-trips a known lambda', () => {
  // P(X > 4) at lambda 4 = 0.371; inverting must return ~4.
  const lam = invertPoissonOver(0.3712, 4.5);
  assert.ok(Math.abs(lam - 4) < 0.05);
});

// --- Phantom-probability guards ----------------------------------------------

test('fixture-only prediction rows never produce candidates (no phantom NG 100%)', () => {
  const fixtureOnly = {
    eventId: 'sr:match:fo1',
    home: 'Alpha FC', away: 'Beta FC', league: 'Obscure League',
    kickoffUtc: '2026-10-06T18:00:00Z',
    h: 0, d: 0, a: 0, btts: 0, o05: 0, o15: 0, u45: 0, o25: 0, oneUpHome: 0, oneUpAway: 0,
    dataSource: 'API-Football fixture only', // legacy snapshot shape
  };
  const ggRows = [
    { eventId: 'sr:match:fo1', marketId: '29', outcomeId: '12', home: 'Alpha FC', away: 'Beta FC', marketDesc: 'Both Teams To Score', outcomeDesc: 'Yes', odds: 1.70, live: true },
    { eventId: 'sr:match:fo1', marketId: '29', outcomeId: '13', home: 'Alpha FC', away: 'Beta FC', marketDesc: 'Both Teams To Score', outcomeDesc: 'No', odds: 2.10, live: true },
  ];
  const oneXtwoRows = oneXtwo('sr:match:fo1', 'Alpha FC', 'Beta FC', 1.90, 3.40, 4.20, { live: true })
    .map(r => ({ ...r, outcomeDesc: r.outcomeDesc === 'Home' ? 'Alpha FC' : r.outcomeDesc === 'Away' ? 'Beta FC' : r.outcomeDesc }));
  const candidates = buildCandidates({
    predictions: { matches: [fixtureOnly] },
    footballMarkets: { '1x2': { rows: oneXtwoRows }, gg: { rows: ggRows } },
    sportScope: 'football',
    minProbability: 0,
    minEdge: -25,
  });
  assert.equal(candidates.length, 0, 'a fixture-only zero row must produce zero candidates');
});

test('a null btts never becomes a phantom 100% NG candidate', () => {
  const row = {
    eventId: 'sr:match:nb1', home: 'Null FC', away: 'Void United', league: 'Test',
    kickoffUtc: KO, h: 50, d: 28, a: 22, btts: null, o05: 90,
    dataSource: 'SportyBet odds (no-vig)',
  };
  const ggRows = [
    { eventId: 'sr:match:nb1', marketId: '29', outcomeId: '12', home: 'Null FC', away: 'Void United', marketDesc: 'GG/NG', outcomeDesc: 'GG', odds: 1.80 },
    { eventId: 'sr:match:nb1', marketId: '29', outcomeId: '13', home: 'Null FC', away: 'Void United', marketDesc: 'GG/NG', outcomeDesc: 'NG', odds: 2.00 },
  ];
  const candidates = buildCandidates({
    predictions: { matches: [row] },
    footballMarkets: { gg: { rows: ggRows } },
    sportScope: 'football',
    minProbability: 0,
    minEdge: -25,
  });
  assert.equal(candidates.filter(c => c.betType === 'ng_no' || c.betType === 'gg_yes').length, 0);
});

test('modeled prediction rows still score against live market rows and keep live flag', () => {
  const modeled = {
    eventId: 'sr:match:lv1',
    home: 'Gamma FC', away: 'Delta FC', league: 'Live League',
    kickoffUtc: '2026-10-06T18:00:00Z',
    h: 62, d: 22, a: 16, btts: 58, o05: 96, o15: 78, u45: 92, o25: 55,
    homeO05: 80, awayO05: 70, homeU45: 95, awayU45: 97,
    oneUpHome: 50, oneUpAway: 25, score: '2-1', scoreP: 11,
    dataSource: 'SportyBet live odds (no-vig)',
  };
  const oneXtwoRows = [
    { eventId: 'sr:match:lv1', marketId: '1', outcomeId: '1', home: 'Gamma FC', away: 'Delta FC', marketDesc: '1X2', outcomeDesc: 'Gamma FC', odds: 1.55, live: true },
    { eventId: 'sr:match:lv1', marketId: '1', outcomeId: '2', home: 'Gamma FC', away: 'Delta FC', marketDesc: '1X2', outcomeDesc: 'Draw', odds: 4.00, live: true },
    { eventId: 'sr:match:lv1', marketId: '1', outcomeId: '3', home: 'Gamma FC', away: 'Delta FC', marketDesc: '1X2', outcomeDesc: 'Delta FC', odds: 6.50, live: true },
  ];
  const candidates = buildCandidates({
    predictions: { matches: [modeled] },
    footballMarkets: { '1x2': { rows: oneXtwoRows } },
    sportScope: 'football',
    minProbability: 0,
    minEdge: -25,
  });
  assert.ok(candidates.length >= 2, 'expected 1X2 candidates from the modeled live fixture');
  assert.ok(candidates.every(c => c.live === true), 'candidates scored from live rows must carry live:true');
  const home = candidates.find(c => c.betType === 'home_win');
  assert.ok(home, 'home win candidate must exist');
  assert.equal(home.probability, 62);
  assert.match(home.probabilitySource, /SportyBet no-vig odds/, 'odds-derived rows must be labelled honestly');
});

// --- server.js / refresh.js wiring -------------------------------------------

test('live merge replaces the same event\'s stale prematch rows', () => {
  assert.match(serverSrc, /const liveEventIds = new Set\(liveRows\.map/, 'mergeLiveRows must collect live event ids');
  assert.match(serverSrc, /base\.filter\(r => !liveEventIds\.has\(String\(r\.eventId \|\| ''\)\)\)/, 'prematch rows for live events must be dropped before merging');
});

test('live football fixtures missing from the snapshot are modeled from live odds', () => {
  assert.match(serverSrc, /function modelLiveFootballFromOdds\(predictions, liveFootballPayloads\)/, 'live odds-modeling helper must exist');
  assert.match(serverSrc, /modelLiveFootballFromOdds\(/, 'live block must call the modeling helper');
  assert.match(serverSrc, /buildRowsFromOdds\(liveFootballPayloads, \{ live: true \}\)/, 'live modeling must use live rows only');
  assert.match(serverSrc, /no_usable_live_odds/, 'live events without a 1X2 price must fail honestly');
});

test('prematch gap-fill models uncovered fixtures from SportyBet odds', () => {
  assert.match(serverSrc, /buildRowsFromOdds\([\s\S]*?\{ live: false \}/, 'prematch gap-fill must use non-live rows');
  assert.match(serverSrc, /appendUncoveredRows\(predictions\?\.matches \|\| \[\], oddsRows\)/, 'existing Poisson + H2H rows must win over odds rows');
});

test('API-Football is fully removed from server and refresh job', () => {
  for (const [name, src] of [['server.js', serverSrc], ['jobs/refresh.js', refreshSrc]]) {
    assert.ok(!src.includes("require('./lib/apiFootball')") && !src.includes("require('../lib/apiFootball')"), `${name} must not require apiFootball`);
    assert.ok(!/API_FOOTBALL_KEY/.test(src), `${name} must not read API_FOOTBALL_KEY`);
    assert.ok(!/enrichSportyFixtures/.test(src), `${name} must not call enrichSportyFixtures`);
  }
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'lib', 'apiFootball.js')), 'lib/apiFootball.js must be deleted');
});

test('live diagnostics flow from loadAutoCandidates into both error surfaces', () => {
  assert.match(serverSrc, /liveDiagnostics = \{ mode: liveModeNorm, rows: \{\}, errors: \{\}, totalRows: 0/, 'per-kind live diagnostics must be collected');
  assert.match(serverSrc, /candidates\.liveDiagnostics = liveDiagnostics/, 'loadAutoCandidates must attach live diagnostics');
  assert.match(serverSrc, /liveDiagnostics: rawCandidates\.liveDiagnostics \|\| null/, 'prepareAutoCandidatePool must surface live diagnostics');
  assert.match(serverSrc, /liveDiagnostics: prepared\.diagnostics\.liveDiagnostics/, 'website 404 must include live diagnostics');
  assert.match(serverSrc, /Live board scrape returned \$\{ld\.totalRows\} rows/, 'Telegram builder error must include the live scrape summary');
});
