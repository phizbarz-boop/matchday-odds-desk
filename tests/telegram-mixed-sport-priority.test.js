'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { SPORT_TIERS, telegramSportTier, selectTelegramMixedWithSportPriority } = require('../lib/telegramMixedSelector');

const WINNER_TYPES = new Set(['hockey_winner','basketball_winner','tennis_winner','handball_winner','volleyball_winner']);
const isWinner = c => WINNER_TYPES.has(c.betType);
const make = (sport, eventId, betType, odds = 1.6, probability = 92) => ({
  sport, eventId, betType, odds, probability, qualityScore: 90,
  edge: 0, expectedReturnMultiplier: 1,
});
const pick = (targetOdds, candidates, maxSelections = 20, sportTiers = SPORT_TIERS) =>
  selectTelegramMixedWithSportPriority({ targetOdds, minProbability: 90 }, candidates, maxSelections,
    { trials: 100, rng: () => 0.5, sportTiers, isWinner });

test('2x/3x default sport order is Hockey + Basketball + Tennis, then Handball + Volleyball', () => {
  assert.deepEqual(SPORT_TIERS, [
    ['hockey','basketball','tennis'], ['handball','volleyball'],
  ]);
  for (const sport of ['Ice Hockey','Basketball','Tennis']) assert.equal(telegramSportTier({sport}), 0);
  for (const sport of ['Handball','Volleyball']) assert.equal(telegramSportTier({sport}), 1);
  assert.equal(telegramSportTier({sport:'Football'}), -1);
});

test('winner markets are used before any other bet type', () => {
  const candidates = [
    make('Ice Hockey','hw','hockey_winner',1.5),
    make('Basketball','bw','basketball_winner',1.5),
    make('Ice Hockey','ht','hockey_over',4.0,99),
    make('Basketball','bt','basketball_under',4.0,99),
  ];
  const selected = pick(2, candidates);
  assert.equal(selected.result.reachedTarget, true);
  assert.equal(selected.winnerOnly, true);
  assert.ok(selected.result.selections.every(isWinner));
});

test('2x/3x stay with Hockey + Basketball + Tennis when that primary pool can complete target', () => {
  const primary = [
    make('Ice Hockey','h','hockey_winner',1.5),
    make('Basketball','b','basketball_winner',1.5),
    make('Tennis','t','tennis_winner',1.5),
  ];
  const fallback = [make('Handball','hb','handball_winner',2), make('Volleyball','vb','volleyball_winner',2)];
  for (const target of [2,3]) {
    const selected = pick(target, [...primary, ...fallback]);
    assert.equal(selected.result.reachedTarget, true);
    assert.equal(selected.fallbackTier, 0);
    assert.equal(selected.priorityOnly, true);
    assert.ok(selected.result.selections.every(c => ['Ice Hockey','Basketball','Tennis'].includes(c.sport)));
  }
});

test('Handball and Volleyball are added only when primary 2x/3x sports cannot complete target', () => {
  const primary = [
    make('Ice Hockey','h','hockey_winner',1.2),
    make('Basketball','b','basketball_winner',1.2),
    make('Tennis','t','tennis_winner',1.2),
  ];
  const fallback = [make('Handball','hb','handball_winner',1.5), make('Volleyball','vb','volleyball_winner',1.5)];
  const selected = pick(3, [...primary, ...fallback], 5);
  assert.equal(selected.result.reachedTarget, true);
  assert.equal(selected.fallbackTier, 1);
  assert.ok(selected.result.selections.some(c => ['Handball','Volleyball'].includes(c.sport)));
  assert.ok(!selected.result.selections.some(c => c.sport === 'Football'));
});

test('non-winner markets are allowed only after winner-only pools cannot reach target', () => {
  const candidates = [
    make('Ice Hockey','h1','hockey_winner',1.1),
    make('Basketball','b1','basketball_winner',1.1),
    make('Tennis','t1','tennis_winner',1.1),
    make('Ice Hockey','h2','hockey_over',2.1),
    make('Basketball','b2','basketball_under',2.1),
  ];
  const selected = pick(2, candidates, 3);
  assert.equal(selected.result.reachedTarget, true);
  assert.equal(selected.winnerOnly, false);
  assert.ok(selected.result.selections.some(c => !isWinner(c)));
});

test('daily Telegram configuration uses 15 selections for 1.30 and 20 for 2x/3x', () => {
  const source = fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  const plans = source.match(/const plans = \[([\s\S]*?)\n  \];/);
  assert.ok(plans, 'daily ticket plan must be defined');
  const planText = plans[1];
  assert.match(planText, /label: '1\.30–5\.00 SAFE', targetOdds: 1\.30, minProbability: 85, minOdds: 1\.30, maxOdds: 5\.00, maxSelections: 15/);
  assert.match(planText, /label: '2', targetOdds: 2, minProbability: 80, mixedMarkets: true, allSports: true, maxSelections: 20/);
  assert.match(planText, /label: '3', targetOdds: 3, minProbability: 80, mixedMarkets: true, allSports: true, maxSelections: 20/);
  assert.match(source, /const TELEGRAM_SAFE_SPORT_TIERS = \[\s*\['hockey','basketball'\],\s*\['tennis'\],\s*\['handball','volleyball'\],/);
  assert.match(source, /const TELEGRAM_2X3X_SPORT_TIERS = \[\s*\['hockey','basketball','tennis'\],\s*\['handball','volleyball'\],/);
  assert.match(source, /isWinner: isTelegramWinnerSelection/);
  assert.doesNotMatch(source.match(/const TELEGRAM_2X3X_SPORT_TIERS = \[([\s\S]*?)\];/)[0], /football/);
  assert.doesNotMatch(planText, /label: '(?:10|20|1000|10000)'/);
});
