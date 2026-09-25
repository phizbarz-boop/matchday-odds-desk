'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { selectAutoBet } = require('../lib/autoPicker');
const { selectTelegramMixedWithSportPriority } = require('../lib/telegramMixedSelector');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = server.indexOf('const TELEGRAM_SAFE_SPORT_TIERS =');
const end = server.indexOf('// Copy Hub is isolated', start);
assert.ok(start > -1 && end > start);
const runnerSource = server.slice(start, end);

function testCandidates(probability = 92) {
  const sports = ['Ice Hockey','Basketball','Handball','Volleyball','Tennis','Football','Ice Hockey','Basketball'];
  return sports.map((sport, index) => ({
    sport, eventId: `event-${index}`, marketId: `market-${index}`,
    outcomeId: `outcome-${index}`, outcomeDesc: 'Over', betType: sport.includes('Hockey') ? 'hockey_over'
      : sport === 'Basketball' ? 'basketball_under' : sport === 'Handball' ? 'handball_over'
      : sport === 'Volleyball' ? 'volleyball_over' : sport === 'Tennis' ? 'tennis_over' : 'over15',
    odds: 1.45, probability, qualityScore: 92, edge: 0, expectedReturnMultiplier: 1,
  }));
}

function mockRunner(candidates) {
  const messages = [], bookings = [], stored = [], tracked = [];
  const ctx = vm.createContext({
    process: { env: { TELEGRAM_PICK_TRIALS: '50', TELEGRAM_MIXED_PICK_TRIALS: '50' } },
    selectAutoBet, selectTelegramMixedWithSportPriority,
    loadAutoCandidates: async () => candidates,
    isCandidateToday: () => true,
    passesRedFlagFilter: () => true,
    fixtureDateKeyInTimeZone: () => '2026-09-18',
    getRedis: async () => ({}),
    saveTelegramDailyCodes: async (_, date, data) => { stored.push({date, codes:data.codes.slice()}); },
    sendTelegramMessage: async message => { messages.push(message); },
    bookBet: async selections => { bookings.push(selections); return {shareCode:`TEST${bookings.length}`}; },
    telegramSlipText: (label, result) => `${label} odds actual ${result.combinedOdds}`,
    trackTelegramSlip: async (_, data) => { tracked.push(data); },
    setTimeout: callback => { callback(); },
  });
  vm.runInContext(runnerSource + '\nthis.runTelegramDailyPicks=runTelegramDailyPicks;', ctx);
  return {run:ctx.runTelegramDailyPicks, messages, bookings, stored, tracked};
}

test('daily runner keeps SAFE at 85% and adds three flexible 1000 sport tickets at 80%', async () => {
  const runner = mockRunner(testCandidates());
  let started = 0;
  const result = await runner.run({onPostingStart: () => {started++;}});
  assert.equal(started, 1);
  const targets = ['1.30–5.00 SAFE','2','3','1000 ICE HOCKEY','1000 BASKETBALL','1000 HANDBALL + VOLLEYBALL'];
  assert.deepEqual(Array.from(result.plans, p => p.target), targets);
  assert.deepEqual(Array.from(result.plans, p => p.minProbability), [85,80,80,80,80,80]);
  assert.deepEqual(Array.from(result.plans, p => p.maxSelections), [15,20,20,15,15,15]);
  assert.equal(runner.bookings.length, 6);
  assert.equal(runner.tracked.length, 6);
  assert.equal(runner.stored.at(-1).codes.length, 6);
  assert.match(runner.messages[0], /SAFE • 2x • 3x/);
  assert.match(runner.messages[0], /1000 target.*Ice Hockey.*Basketball.*Handball \+ Volleyball/);

  for (const ticket of result.results) {
    assert.ok(ticket.shareCode);
    const floor = ticket.targetOdds === '1.30–5.00 SAFE' ? 85 : 80;
    assert.ok(ticket.minimumProbability === undefined || ticket.minimumProbability >= floor);
    if (ticket.targetOdds === '2') assert.ok(ticket.combinedOdds >= 2);
    if (ticket.targetOdds === '3') assert.ok(ticket.combinedOdds >= 3);
    if (ticket.targetOdds === '1.30–5.00 SAFE') assert.ok(ticket.combinedOdds >= 1.3 && ticket.combinedOdds <= 5);
    if (String(ticket.targetOdds).startsWith('1000 ')) {
      assert.equal(ticket.flexibleTarget, true);
      assert.ok(ticket.selections <= 15);
      // Test pool intentionally cannot reach 1000; it must still publish.
      assert.ok(ticket.combinedOdds < 1000);
    }
  }

  const hockey = runner.tracked.find(x => x.targetOdds === '1000 ICE HOCKEY');
  const basketball = runner.tracked.find(x => x.targetOdds === '1000 BASKETBALL');
  const handVolley = runner.tracked.find(x => x.targetOdds === '1000 HANDBALL + VOLLEYBALL');
  assert.ok(hockey.selections.every(x => x.sport === 'Ice Hockey'));
  assert.ok(basketball.selections.every(x => x.sport === 'Basketball'));
  assert.ok(handVolley.selections.every(x => ['Handball','Volleyball'].includes(x.sport)));
});

test('84% candidates skip SAFE but can build 2x/3x and all three 1000 sport tickets', async () => {
  const runner = mockRunner(testCandidates(84));
  const result = await runner.run();
  assert.deepEqual(Array.from(result.results, p => p.targetOdds), [
    '1.30–5.00 SAFE','2','3','1000 ICE HOCKEY','1000 BASKETBALL','1000 HANDBALL + VOLLEYBALL'
  ]);
  assert.match(result.results[0].error, /No selections met the 85%/);
  assert.equal(result.results[1].shareCode, 'TEST1');
  assert.equal(result.results[2].shareCode, 'TEST2');
  assert.equal(result.results[3].shareCode, 'TEST3');
  assert.equal(result.results[4].shareCode, 'TEST4');
  assert.equal(result.results[5].shareCode, 'TEST5');
  assert.equal(runner.bookings.length, 5);
});

test('the daily runner rejects an entirely below-80% candidate pool for every ticket', async () => {
  const runner = mockRunner(testCandidates(79));
  const result = await runner.run();
  assert.equal(runner.bookings.length, 0);
  assert.deepEqual(Array.from(result.results, p => p.targetOdds), [
    '1.30–5.00 SAFE','2','3','1000 ICE HOCKEY','1000 BASKETBALL','1000 HANDBALL + VOLLEYBALL'
  ]);
  assert.match(result.results[0].error, /No selections met the 85%/);
  for (const ticket of result.results.slice(1)) assert.match(ticket.error, /No selections met the 80%/);
});

test('Today’s Codes shows SAFE and 2x to Free, with 3x restricted', () => {
  const from = server.indexOf('function telegramDailyCodeVisibleForPlan(');
  const to = server.indexOf('function plot207TelegramHelpText(', from);
  const fromText = server.indexOf('function telegramDailyCodesText(');
  const toText = server.indexOf('function sanitizeTelegramSlip(', fromText);
  const ctx = vm.createContext({ fixtureDateKeyInTimeZone:()=> '2026-09-18' });
  vm.runInContext(server.slice(from,to) + '\n' + server.slice(fromText,toText) + '\nthis.render=telegramDailyCodesText;',ctx);
  const snapshot = {date:'2026-09-18',codes:[
    {targetOdds:'1.30–5.00 SAFE',shareCode:'SAFE123'},
    {targetOdds:'2',shareCode:'TWO123'},
    {targetOdds:'3',shareCode:'THREE123'},
    {targetOdds:'10',shareCode:'OLD123'},
  ]};
  const free = ctx.render(snapshot,{id:'free'});
  assert.match(free,/SAFE123/);
  assert.match(free,/TWO123/);
  assert.doesNotMatch(free,/THREE123|OLD123/);
  assert.match(free,/3x.*Pro\/Elite only/);
  const pro=ctx.render(snapshot,{id:'pro'});
  assert.match(pro,/THREE123/);
  assert.doesNotMatch(pro,/OLD123/);
});
