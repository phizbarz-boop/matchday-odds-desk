'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { SPORT_TIERS, telegramSportTier, selectTelegramMixedWithSportPriority } = require('../lib/telegramMixedSelector');

const make = (sport, eventId, betType = 'hockey_over', odds = 1.6, probability = 85) => ({
  sport, eventId, betType, odds, probability, qualityScore: 90,
  edge: 0, expectedReturnMultiplier: 1,
});
const pick = (targetOdds, minProbability, candidates, maxSelections = 3) =>
  selectTelegramMixedWithSportPriority({ targetOdds, minProbability }, candidates, maxSelections,
    { trials: 50, rng: () => 0.5 });

test('tier order: Ice Hockey and Basketball, then Handball, Volleyball, Tennis, Football', () => {
  assert.deepEqual(SPORT_TIERS, [
    ['hockey', 'basketball'], ['handball'], ['volleyball'], ['tennis'], ['football'],
  ]);
  for (const [sport, tier] of [['Ice Hockey',0],['Basketball',0],['Handball',1],['Volleyball',2],['Tennis',3],['Football',4]])
    assert.equal(telegramSportTier({ sport }), tier);
});

test('10x/20x allow mixed Over/Under and stop before fallback when hockey/basketball reach target', () => {
  const primary = Array.from({length: 12}, (_, n) => make(n % 2 ? 'Basketball' : 'Ice Hockey', `${n}`, n % 2 ? 'basketball_under' : 'hockey_over', 1.5, 82));
  const fallback = [make('Football', 'fb', 'home_win', 20, 99), make('Handball','hb','handball_winner',20,99)];
  for (const target of [10,20]) {
    const selected = pick(target, 80, [...primary, ...fallback], 30);
    assert.equal(selected.result.reachedTarget, true);
    assert.equal(selected.fallbackTier, 0);
    assert.equal(selected.priorityOnly, true);
    assert.ok(selected.result.selections.every(c => /^(Ice Hockey|Basketball)$/.test(c.sport)));
    assert.ok(selected.result.selections.some(c => /over|under/.test(c.betType)));
    assert.ok(selected.result.selections.every(c => c.probability >= 80));
  }
});

test('fallback opens one sport at a time when previous pool cannot complete the target', () => {
  const base = [make('Ice Hockey','h','hockey_under'), make('Basketball','b','basketball_over')];
  const ordered = [
    make('Handball','hand','handball_over'), make('Volleyball','vol','volleyball_under'),
    make('Tennis','ten','tennis_over'), make('Football','foot','over15'),
  ];
  for (let index = 0; index < ordered.length; index++) {
    const result = pick(3.5, 80, [...base, ...ordered.slice(index,index+1)], 3);
    assert.equal(result.result.reachedTarget, true);
    assert.equal(result.fallbackTier, index + 1);
    assert.ok(result.result.selections.some(c => c.eventId === ordered[index].eventId));
    assert.equal(result.result.selections.length, 3);
  }
});

test('the first viable fallback is used even if later sports have much higher odds', () => {
  const candidates = [
    make('Ice Hockey','ice','hockey_over'),
    make('Basketball','basket','basketball_under'),
    make('Handball','hand','handball_over'),
    make('Volleyball','vol','volleyball_over',10),
    make('Tennis','ten','tennis_winner',10),
    make('Football','foot','home_win',10),
  ];
  const picked = pick(3.5, 80, candidates, 3);
  assert.equal(picked.result.reachedTarget, true);
  assert.equal(picked.fallbackTier, 1);
  assert.ok(picked.result.selections.every(c => ['Ice Hockey','Basketball','Handball'].includes(c.sport)));
});

test('1000x/10000x use 70% floor, maximum 40 legs, and keep closest-available when short', () => {
  const candidates = Array.from({length: 10}, (_, n) =>
    make(n % 2 ? 'Basketball' : 'Ice Hockey', `p${n}`, n % 2 ? 'basketball_over' : 'hockey_under', 1.5, 75));
  candidates.push(make('Football','bad','home_win', 50, 69));
  for (const target of [1000,10000]) {
    const selected = pick(target, 70, candidates, 40);
    assert.ok(selected.result.selections.length > 0);
    assert.equal(selected.result.reachedTarget, false);
    assert.equal(selected.fallbackTier, 4);
    assert.ok(selected.result.selections.every(c => c.probability >= 70));
    assert.ok(selected.result.selections.length <= 40);
    assert.ok(!selected.result.selections.some(c => c.eventId === 'bad'));
  }
});

test('server config enables mixed supported markets for each of four targets and retains SAFE separately', () => {
  const source = fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  assert.match(source, /label: '10', targetOdds: 10, minProbability: 80, mixedMarkets: true, allSports: true, maxSelections: 30/);
  assert.match(source, /label: '20', targetOdds: 20, minProbability: 80, mixedMarkets: true, allSports: true, maxSelections: 30/);
  assert.match(source, /label: '1000', targetOdds: 1000, minProbability: 70, mixedMarkets: true, allSports: true, maxSelections: 40/);
  assert.match(source, /label: '10000', targetOdds: 10000, minProbability: 70, mixedMarkets: true, allSports: true, maxSelections: 40/);
  assert.match(source, /'basketball_over', 'basketball_under', 'hockey_over', 'hockey_under'/);
  assert.match(source, /'corners_over', 'corners_under'/);
  assert.doesNotMatch(source.match(/const TELEGRAM_FALLBACK_BET_TYPES = \[[\s\S]*?\];/)[0], /\boneup\b|first_half_home_team_corners|first_half_away_team_corners/);
  assert.match(source, /label: '1\.30–5\.00 SAFE', targetOdds: 5\.00, minProbability: 90, minOdds: 1\.30, maxOdds: 5\.00/);
  assert.match(source, /const picked = isSafePlan\s*\? selectTelegramSafeWithPriority\(plan, planCandidates, planMaxSelections\)\s*: selectTelegramMixedWithSportPriority\(plan, planCandidates, planMaxSelections\)/);
});
