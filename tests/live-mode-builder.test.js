'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const bot = require('../lib/telegramAiBot');
const { buildCandidates } = require('../lib/autoPicker');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const refreshSrc = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'refresh.js'), 'utf8');

// --- Telegram bot library -------------------------------------------------

test('builder and analyzer defaults include live options', () => {
  const user = { telegramId: 't1', preferences: {} };
  // freshUser shape via getUser normalization
  return bot.getUser(null, 't1', {}).then(u => {
    assert.equal(u.preferences.builder.liveMode, 'prematch');
    assert.equal(u.preferences.analyzer.includeLive, false);
  });
});

test('normalization repairs invalid live preferences', async () => {
  const raw = {
    telegramId: 't2',
    preferences: {
      builder: { liveMode: 'sometimes', betTypes: ['home_win'] },
      analyzer: { includeLive: 'yes' },
    },
  };
  // emulate a stored record by pre-seeding the memory store
  await bot.saveUser(null, raw);
  const u = await bot.getUser(null, 't2', {});
  assert.equal(u.preferences.builder.liveMode, 'prematch');
  assert.equal(u.preferences.analyzer.includeLive, false);
});

test('builder keyboard exposes a live-mode cycle button', async () => {
  const u = await bot.getUser(null, 't3', {});
  const kb = bot.builderKeyboard(u);
  const buttons = kb.inline_keyboard.flat();
  const liveBtn = buttons.find(b => b.callback_data === 'builder:live');
  assert.ok(liveBtn, 'builder keyboard must include builder:live');
  assert.match(liveBtn.text, /PREMATCH/);
  const summary = bot.builderSummary(u);
  assert.match(summary, /Matches: /);
});

test('analyzer keyboard exposes the live opt-in toggle', async () => {
  const u = await bot.getUser(null, 't4', {});
  const kb = bot.analyzerKeyboard(u);
  const buttons = kb.inline_keyboard.flat();
  const liveBtn = buttons.find(b => b.callback_data === 'analyzer:live');
  assert.ok(liveBtn, 'analyzer keyboard must include analyzer:live');
  assert.match(liveBtn.text, /OFF/);
  assert.match(bot.analyzerSummary(u), /Live games: /);
});

test('natural language parser detects live requests', () => {
  const live = bot.parseNaturalRequest('build me a live football 5x ticket');
  assert.equal(live.intent, 'ticket');
  assert.equal(live.liveMode, 'live');

  const inplay = bot.parseNaturalRequest('give me a 10x in-play ticket');
  assert.equal(inplay.liveMode, 'live');

  const ongoing = bot.parseNaturalRequest('build a 3x ticket with ongoing games');
  assert.equal(ongoing.liveMode, 'live');

  const both = bot.parseNaturalRequest('live and prematch 5x');
  assert.equal(both.liveMode, 'both');

  const prematch = bot.parseNaturalRequest('build football 10x today');
  assert.equal(prematch.liveMode, undefined, 'no live keyword must not override saved preference');
});

// --- autoPicker live flag propagation --------------------------------------

test('buildCandidates keeps the live flag on live-tagged market rows', () => {
  const rows = [
    { eventId: 'sr:match:l1', marketId: '1', outcomeId: '1', home: 'Team A', away: 'Team B', tournament: 'Live League', marketDesc: '1X2', outcomeDesc: 'Team A', odds: 1.40, live: true },
    { eventId: 'sr:match:l1', marketId: '1', outcomeId: '2', home: 'Team A', away: 'Team B', tournament: 'Live League', marketDesc: '1X2', outcomeDesc: 'Draw', odds: 4.50, live: true },
    { eventId: 'sr:match:l1', marketId: '1', outcomeId: '3', home: 'Team A', away: 'Team B', tournament: 'Live League', marketDesc: '1X2', outcomeDesc: 'Team B', odds: 8.00, live: true },
  ];
  const candidates = buildCandidates({
    predictions: { matches: [] },
    basketballWinner: { rows },
    sportScope: 'basketball',
    minProbability: 0,
    minEdge: -25,
  });
  assert.ok(candidates.length >= 1, 'expected at least one basketball winner candidate');
  assert.ok(candidates.every(c => c.live === true), 'every candidate must carry live:true');
});

test('buildCandidates defaults prematch rows to live:false', () => {
  const rows = [
    { eventId: 'sr:match:p1', marketId: '1', outcomeId: '1', home: 'Team C', away: 'Team D', tournament: 'League', marketDesc: '1X2', outcomeDesc: 'Team C', odds: 1.40 },
    { eventId: 'sr:match:p1', marketId: '1', outcomeId: '2', home: 'Team C', away: 'Team D', tournament: 'League', marketDesc: '1X2', outcomeDesc: 'Draw', odds: 4.50 },
    { eventId: 'sr:match:p1', marketId: '1', outcomeId: '3', home: 'Team C', away: 'Team D', tournament: 'League', marketDesc: '1X2', outcomeDesc: 'Team D', odds: 8.00 },
  ];
  const candidates = buildCandidates({
    predictions: { matches: [] },
    basketballWinner: { rows },
    sportScope: 'basketball',
    minProbability: 0,
    minEdge: -25,
  });
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.every(c => c.live === false));
});

// --- server.js wiring -------------------------------------------------------

test('server normalizes live mode and threads it through the builder pipeline', () => {
  assert.match(serverSrc, /function normalizeLiveMode\(value\)/);
  assert.match(serverSrc, /liveMode\s*=\s*'prematch'\s*\}\s*=\s*\{\}/, 'loadAutoCandidates must accept liveMode');
  assert.match(serverSrc, /const wantsPrematch = !\['live','quick_cash'\]\.includes\(liveModeNorm\)/);
  assert.match(serverSrc, /const wantsLive = liveModeNorm !== 'prematch'/);
  assert.match(serverSrc, /if \(wantsLive\) \{/, 'live merge block must exist');
  assert.match(serverSrc, /liveCandidates: oddsSafe\.filter/, 'diagnostics must report live candidates');
});

test('booking route re-validates live legs before creating a code', () => {
  assert.match(serverSrc, /const liveLegs = selections\.filter\(s => s && s\.live === true\)/);
  assert.match(serverSrc, /await validateLiveSelections\(liveLegs/);
  assert.match(serverSrc, /code: 'LIVE_LEGS_DROPPED'/);
  assert.match(serverSrc, /code: 'LIVE_VALIDATION_UNAVAILABLE'/);
  assert.match(serverSrc, /\.\.\.\(droppedLive\.length \? \{ droppedLive \} : \{\}\)/);
});

test('telegram ticket builder validates live legs and reports dropped ones', () => {
  assert.match(serverSrc, /const liveMode = normalizeLiveMode\(merged\.liveMode\)/);
  assert.match(serverSrc, /builder:live/);
  assert.match(serverSrc, /analyzer:live/);
  assert.match(serverSrc, /droppedLive, request: \{ \.\.\.merged/);
  assert.match(serverSrc, /🔴 LIVE ONLY/);
});

test('telegram analyzer supports the include-live opt-in', () => {
  assert.match(serverSrc, /async function analyzeTelegramAiCode\(bookingCode, minProbability = 70, horizonDays = 14, replaceUnsupported = false, includeLive = false\)/);
  assert.match(serverSrc, /liveMode: includeLive \? 'both' : 'prematch'/);
  assert.match(serverSrc, /includeLive:!!cfg\.includeLive/);
});

// --- website ----------------------------------------------------------------

test('standalone live page is removed and Auto Builder carries the match-status option', () => {
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'live.html')), 'public/live.html must be deleted');
  assert.ok(!/href="\/live\.html"/.test(indexSrc), 'header must not link to live.html');
  assert.match(indexSrc, /id="auto-live-mode"/);
  assert.match(indexSrc, /Live only \(ongoing games\)/);
  assert.match(indexSrc, /state\.autoLiveMode=liveMode/);
  assert.match(indexSrc, /maxSelections,todayOnly,liveMode,betTypes,leagues/, 'auto-pick POST body must include liveMode');
  assert.match(indexSrc, /x\.live===true\?\{live:true,quickCash:/, 'booking selections must carry live flag');
  assert.match(indexSrc, /🔴 LIVE /, 'slip rows must show the live badge');
  assert.match(indexSrc, /p\.droppedLive/, 'booking result must surface dropped live legs');
});

// --- refresh job --------------------------------------------------------------

test('daily refresh seeds snapshots for all six sports with file fallback', () => {
  assert.match(refreshSrc, /async function collectSportySnapshots/);
  for (const sport of ['basketball', 'hockey', 'handball', 'volleyball', 'tennis']) {
    assert.ok(refreshSrc.includes(`${sport}: ['winner','totals'`), `refresh must seed ${sport} snapshots`);
  }
  assert.match(refreshSrc, /'1x2','gg','dc','dnb','ou05','ou15','ou45','ou25','cs','ah','corners'/);
  assert.match(refreshSrc, /'home_ou05','away_ou05','home_ou45','away_ou45'/);
  assert.match(refreshSrc, /function sportySnapshotKey\(sport, kind\)/, 'refresh must share the server snapshot key scheme');
  assert.match(refreshSrc, /writeSnapshotFile\(key, \{ \.\.\.snap\.payload/, 'no-Redis branch must write snapshot files');
  assert.match(refreshSrc, /SPORTYBET_SNAPSHOT_SEED/, 'snapshot seeding must be toggleable');
});

test('refresh snapshot keys match the server scheme including the team-goal suffix', () => {
  assert.match(refreshSrc, /sportybet:snapshot:v\$\{v\}:\$\{sport\}:\$\{kind\}/);
  assert.match(refreshSrc, /'-ng-team-v2'/);
  assert.match(serverSrc, /sportybet:snapshot:v\$\{v\}:\$\{sport\}:\$\{kind\}/);
  assert.match(serverSrc, /'-ng-team-v2'/);
});
