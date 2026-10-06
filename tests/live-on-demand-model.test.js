'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildCandidates } = require('../lib/autoPicker');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// --- Fixture-only rows must never be scored ----------------------------------
// When API-Football knows a fixture but cannot build a goal model, the snapshot
// stores a zero placeholder (h:0, d:0, a:0, btts:0, ...). Scoring those zeros
// would turn btts:0 into a phantom 100% NG candidate. buildCandidates must skip
// such rows entirely.

test('fixture-only prediction rows never produce candidates (no phantom NG 100%)', () => {
  const fixtureOnly = {
    eventId: 'sr:match:fo1',
    home: 'Alpha FC', away: 'Beta FC', league: 'Obscure League',
    kickoffUtc: '2026-10-06T18:00:00Z',
    h: 0, d: 0, a: 0, btts: 0, o05: 0, o15: 0, u45: 0, o25: 0, oneUpHome: 0, oneUpAway: 0,
    dataSource: 'API-Football fixture only',
  };
  const ggRows = [
    { eventId: 'sr:match:fo1', marketId: '29', outcomeId: '12', home: 'Alpha FC', away: 'Beta FC', marketDesc: 'Both Teams To Score', outcomeDesc: 'Yes', odds: 1.70, live: true },
    { eventId: 'sr:match:fo1', marketId: '29', outcomeId: '13', home: 'Alpha FC', away: 'Beta FC', marketDesc: 'Both Teams To Score', outcomeDesc: 'No', odds: 2.10, live: true },
  ];
  const oneXtwoRows = [
    { eventId: 'sr:match:fo1', marketId: '1', outcomeId: '1', home: 'Alpha FC', away: 'Beta FC', marketDesc: '1X2', outcomeDesc: 'Alpha FC', odds: 1.90, live: true },
    { eventId: 'sr:match:fo1', marketId: '1', outcomeId: '2', home: 'Alpha FC', away: 'Beta FC', marketDesc: '1X2', outcomeDesc: 'Draw', odds: 3.40, live: true },
    { eventId: 'sr:match:fo1', marketId: '1', outcomeId: '3', home: 'Alpha FC', away: 'Beta FC', marketDesc: '1X2', outcomeDesc: 'Beta FC', odds: 4.20, live: true },
  ];
  const candidates = buildCandidates({
    predictions: { matches: [fixtureOnly] },
    footballMarkets: { '1x2': { rows: oneXtwoRows }, gg: { rows: ggRows } },
    sportScope: 'football',
    minProbability: 0,
    minEdge: -25,
  });
  assert.equal(candidates.length, 0, 'a fixture-only zero row must produce zero candidates');
});

test('modeled prediction rows still score against live market rows and keep live flag', () => {
  const modeled = {
    eventId: 'sr:match:lv1',
    home: 'Gamma FC', away: 'Delta FC', league: 'Live League',
    kickoffUtc: '2026-10-06T18:00:00Z',
    h: 62, d: 22, a: 16, btts: 58, o05: 96, o15: 78, u45: 92, o25: 55,
    homeO05: 80, awayO05: 70, homeU45: 95, awayU45: 97,
    oneUpHome: 50, oneUpAway: 25, score: '2-1', scoreP: 11,
    dataSource: 'API-Football prediction',
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
});

// --- server.js live pipeline wiring ------------------------------------------

test('live merge replaces the same event\'s stale prematch rows', () => {
  assert.match(serverSrc, /const liveEventIds = new Set\(liveRows\.map/, 'mergeLiveRows must collect live event ids');
  assert.match(serverSrc, /base\.filter\(r => !liveEventIds\.has\(String\(r\.eventId \|\| ''\)\)\)/, 'prematch rows for live events must be dropped before merging');
});

test('live football fixtures missing from the snapshot are modeled on demand', () => {
  assert.match(serverSrc, /async function addLiveFootballModels\(predictions, liveFootballPayloads/, 'on-demand live modeling helper must exist');
  assert.match(serverSrc, /SPORTYBET_LIVE_MODEL_MAX_EVENTS/, 'live modeling must be bounded by an env cap');
  assert.match(serverSrc, /await addLiveFootballModels\(/, 'live block must call the modeling helper');
  assert.match(serverSrc, /cornerBetRequested\(betTypes\)/, 'live corner modeling must stay gated on an explicit corner bet type');
  assert.match(serverSrc, /api_key_not_configured/, 'missing API key must skip modeling honestly');
});

test('live diagnostics flow from loadAutoCandidates into both error surfaces', () => {
  assert.match(serverSrc, /liveDiagnostics = \{ mode: liveModeNorm, rows: \{\}, errors: \{\}, totalRows: 0/, 'per-kind live diagnostics must be collected');
  assert.match(serverSrc, /candidates\.liveDiagnostics = liveDiagnostics/, 'loadAutoCandidates must attach live diagnostics');
  assert.match(serverSrc, /liveDiagnostics: rawCandidates\.liveDiagnostics \|\| null/, 'prepareAutoCandidatePool must surface live diagnostics');
  assert.match(serverSrc, /liveDiagnostics: prepared\.diagnostics\.liveDiagnostics/, 'website 404 must include live diagnostics');
  assert.match(serverSrc, /Live board scrape returned \$\{ld\.totalRows\} rows/, 'Telegram builder error must include the live scrape summary');
});
