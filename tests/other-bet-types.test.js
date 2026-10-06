'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildCandidates } = require('../lib/autoPicker');
const { isDetailedMarketRow } = require('../lib/sportybet');
const { ALL_BET_IDS, SPECIAL_BET_IDS, allowedBetIdsForPlan, marketsKeyboard, parseNaturalRequest } = require('../lib/telegramAiBot');

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const kickoffUtc = new Date(Date.now() + 86400000).toISOString();

const prediction = {
  home: 'Alpha FC', away: 'Beta FC', league: 'Test League', kickoffUtc,
  h: 50, d: 25, a: 25, btts: 45, o05: 94, o15: 80, u45: 78, o25: 64,
  score: '2-1', scoreP: 14,
};
const ou25Rows = [
  { eventId: 'e1', marketId: '18', outcomeId: '12', marketDesc: 'Over/Under', outcomeDesc: 'Over 2.5', specifier: 'total=2.5', odds: 2.10, home: 'Alpha FC', away: 'Beta FC', kickoffUtc },
  { eventId: 'e1', marketId: '18', outcomeId: '13', marketDesc: 'Over/Under', outcomeDesc: 'Under 2.5', specifier: 'total=2.5', odds: 1.75, home: 'Alpha FC', away: 'Beta FC', kickoffUtc },
];

test('football Over 2.5 uses the model o25 probability and Under 2.5 its complement', () => {
  const candidates = buildCandidates({
    predictions: { matches: [prediction] },
    footballMarkets: { ou25: { rows: ou25Rows } },
    minProbability: 0, minEdge: -25, sportScope: 'football', betTypes: ['over25', 'under25'],
  });
  assert.deepEqual(new Set(candidates.map(x => x.betType)), new Set(['over25', 'under25']));
  assert.equal(candidates.find(x => x.betType === 'over25').probability, 64);
  assert.equal(candidates.find(x => x.betType === 'under25').probability, 36);
  assert.equal(candidates.find(x => x.betType === 'over25').marketId, '18');
  assert.equal(candidates.find(x => x.betType === 'over25').specifier, 'total=2.5');
});

test('Correct Score candidate matches the model top scoreline exactly', () => {
  const csRows = [
    { eventId: 'e1', marketId: '31', outcomeId: '9001', marketDesc: 'Correct Score', outcomeDesc: '2-1', specifier: null, odds: 8.50, home: 'Alpha FC', away: 'Beta FC', kickoffUtc },
    { eventId: 'e1', marketId: '31', outcomeId: '9002', marketDesc: 'Correct Score', outcomeDesc: '1-0', specifier: null, odds: 7.00, home: 'Alpha FC', away: 'Beta FC', kickoffUtc },
  ];
  const candidates = buildCandidates({
    predictions: { matches: [prediction] },
    footballMarkets: { cs: { rows: csRows } },
    minProbability: 0, minEdge: -25, sportScope: 'football', betTypes: ['correct_score'],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].betType, 'correct_score');
  assert.equal(candidates[0].outcomeDesc, '2-1');
  assert.equal(candidates[0].probability, 14);
  assert.equal(candidates[0].settlementNote, 'Exact final score must match');
  // A different model scoreline must not borrow the 2-1 bookmaker outcome.
  const other = buildCandidates({
    predictions: { matches: [{ ...prediction, score: '3-0' }] },
    footballMarkets: { cs: { rows: csRows } },
    minProbability: 0, minEdge: -25, sportScope: 'football', betTypes: ['correct_score'],
  });
  assert.equal(other.length, 0);
});

test('correct-score market matcher rejects half-time score variants', () => {
  const fullTime = { marketDesc: 'Correct Score', outcomeDesc: '2-1', specifier: '' };
  const firstHalf = { marketDesc: '1st Half Correct Score', outcomeDesc: '1-0', specifier: '' };
  assert.equal(isDetailedMarketRow(fullTime, 'cs'), true);
  assert.equal(isDetailedMarketRow(firstHalf, 'cs'), false);
});

const handicapRows = (homeOdds, awayOdds, homeDesc = 'Home (-5.5)', awayDesc = 'Away (+5.5)') => [
  { eventId: 'b1', marketId: '223', outcomeId: '1714', marketDesc: 'Handicap', outcomeDesc: homeDesc, specifier: 'hcp=-5.5', odds: homeOdds, home: 'Lakers', away: 'Celtics', kickoffUtc },
  { eventId: 'b1', marketId: '223', outcomeId: '1715', marketDesc: 'Handicap', outcomeDesc: awayDesc, specifier: 'hcp=-5.5', odds: awayOdds, home: 'Lakers', away: 'Celtics', kickoffUtc },
];

test('basketball handicap lines are de-margined into home/away no-vig probabilities', () => {
  const candidates = buildCandidates({
    predictions: { matches: [] },
    basketballHandicap: { rows: handicapRows(1.90, 1.90) },
    minProbability: 0, minEdge: -25, sportScope: 'basketball', betTypes: ['basketball_handicap_home', 'basketball_handicap_away'],
  });
  assert.equal(candidates.length, 2);
  const home = candidates.find(x => x.betType === 'basketball_handicap_home');
  const away = candidates.find(x => x.betType === 'basketball_handicap_away');
  assert.ok(home && away);
  assert.equal(home.probability, 50);
  assert.equal(away.probability, 50);
  assert.equal(home.probabilitySource, 'No-vig Handicap market probability');
  assert.equal(home.live, false);
});

test('handicap side is never guessed when the outcome label is ambiguous', () => {
  const candidates = buildCandidates({
    predictions: { matches: [] },
    hockeyHandicap: { rows: handicapRows(1.95, 1.85, 'Selection 1', 'Selection 2') },
    minProbability: 0, minEdge: -25, sportScope: 'hockey', betTypes: ['hockey_handicap_home', 'hockey_handicap_away'],
  });
  // outcomeIds 1714/1715 still resolve the side even with generic descriptions;
  // remove that signal and the line must be dropped entirely.
  assert.equal(candidates.length, 2);
  const noIds = handicapRows(1.95, 1.85, 'Selection 1', 'Selection 2').map(x => ({ ...x, outcomeId: 'x' }));
  const dropped = buildCandidates({
    predictions: { matches: [] },
    hockeyHandicap: { rows: noIds },
    minProbability: 0, minEdge: -25, sportScope: 'hockey', betTypes: ['hockey_handicap_home', 'hockey_handicap_away'],
  });
  assert.equal(dropped.length, 0);
});

test('handball and volleyball handicaps share the same no-vig generator', () => {
  for (const [key, sport, scope] of [
    ['handballHandicap', 'Handball', 'handball'],
    ['volleyballHandicap', 'Volleyball', 'volleyball'],
  ]) {
    const candidates = buildCandidates({
      predictions: { matches: [] },
      [key]: { rows: handicapRows(2.00, 1.80) },
      minProbability: 0, minEdge: -25, sportScope: scope, betTypes: [`${scope}_handicap_home`, `${scope}_handicap_away`],
    });
    assert.equal(candidates.length, 2, `${sport} handicap should produce both sides`);
    assert.ok(candidates.every(x => x.sport === sport));
  }
});

test('special bet ids are registered, Elite-only, and exposed in the markets keyboard', () => {
  assert.equal(SPECIAL_BET_IDS.length, 11);
  for (const id of SPECIAL_BET_IDS) {
    assert.ok(ALL_BET_IDS.includes(id), `${id} must be a registered bet type`);
    assert.ok(allowedBetIdsForPlan('elite').includes(id), `${id} must be available on Elite`);
    assert.ok(!allowedBetIdsForPlan('pro').includes(id), `${id} stays Elite-only like Corners`);
    assert.ok(!allowedBetIdsForPlan('free').includes(id), `${id} stays locked on Free`);
  }
  const eliteUser = { plan: 'elite', preferences: { builder: { betTypes: [...SPECIAL_BET_IDS] } } };
  const keyboard = marketsKeyboard(eliteUser);
  const specialBtn = keyboard.inline_keyboard.flat().find(b => b.callback_data === 'markets:special');
  assert.ok(specialBtn, 'markets keyboard must carry the Special Bet Types button');
  assert.match(specialBtn.text, /Special Bet Types: ON/);
  const freeKeyboard = marketsKeyboard({ plan: 'free', preferences: { builder: { betTypes: [] } } });
  const lockedBtn = freeKeyboard.inline_keyboard.flat().find(b => /Special Bet Types/.test(b.text));
  assert.equal(lockedBtn.callback_data, 'locked:market');
});

test('natural-language builder understands over/under 2.5 and correct score', () => {
  const over = parseNaturalRequest('build football 10x over 2.5');
  assert.ok(over.betTypes.includes('over25'));
  const under = parseNaturalRequest('football ticket under 2.5 goals');
  assert.ok(under.betTypes.includes('under25'));
  const cs = parseNaturalRequest('build a correct score ticket 20x');
  assert.ok(cs.betTypes.includes('correct_score'));
});

test('server wires the new markets into fetch jobs, live jobs and the Telegram sport map', () => {
  assert.match(serverSrc, /loadSportyBetMarket\('ou25', 'football', autoMarketOptions\)/);
  assert.match(serverSrc, /loadSportyBetMarket\('cs', 'football', autoMarketOptions\)/);
  assert.match(serverSrc, /loadSportyBetMarket\('handicap', 'basketball', autoMarketOptions\)/);
  assert.match(serverSrc, /loadSportyBetMarket\('handicap', 'handball', autoMarketOptions\)/);
  assert.match(serverSrc, /\['football', 'ou25', needFOu25/);
  assert.match(serverSrc, /\['football', 'cs', needFCs/);
  assert.match(serverSrc, /\['volleyball', 'handicap', needVolleyballHandicap/);
  assert.match(serverSrc, /ou25: fou25, cs: fcs/);
  for (const id of SPECIAL_BET_IDS) {
    assert.ok(serverSrc.includes(`'${id}'`), `server bet-type maps must include ${id}`);
  }
  assert.match(serverSrc, /d === 'markets:special'/);
});

test('website exposes the Other/Special master toggle and the new bet types', () => {
  assert.match(indexSrc, /SPECIAL_AUTO_BET_IDS/);
  assert.match(indexSrc, /Other \/ Special bet types/);
  for (const id of SPECIAL_BET_IDS) {
    assert.ok(indexSrc.includes(`id:'${id}'`), `website bet types must include ${id}`);
  }
});
