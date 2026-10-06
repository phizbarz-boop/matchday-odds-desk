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

test('daily runner keeps only the morning SAFE ticket at 85%', async () => {
  const runner = mockRunner(testCandidates());
  const result = await runner.run();
  assert.deepEqual(Array.from(result.plans, p => p.target), ['1.30–5.00 SAFE']);
  assert.deepEqual(Array.from(result.plans, p => p.minProbability), [85]);
  assert.equal(runner.bookings.length, 1);
  assert.equal(runner.tracked.length, 1);
  assert.equal(runner.stored.at(-1).codes.length, 1);
  assert.ok(result.results[0].combinedOdds >= 1.3 && result.results[0].combinedOdds <= 5);
  assert.doesNotMatch(runner.messages[0], /SAFE • 2x • 3x|1000 target/);
});

test('below-85% candidates do not generate the morning SAFE ticket', async () => {
  const runner = mockRunner(testCandidates(84));
  const result = await runner.run();
  assert.equal(runner.bookings.length, 0);
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].error, /No selections met the 85%/);
});

test('Today’s Codes reveals the five hourly categories and hides retired tickets', () => {
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
    {targetOdds:'1000 ICE HOCKEY',shareCode:'HOCKEY1000'},
    {targetOdds:'1000 BASKETBALL',shareCode:'BASKET1000'},
    {targetOdds:'1000 HANDBALL + VOLLEYBALL',shareCode:'HVB1000'},
  ]};
  snapshot.codes.push(
    {targetOdds:'QC FOOTBALL · 19:00 WAT',shareCode:'QCF123'},
    {targetOdds:'QC ICE HOCKEY · 19:00 WAT',shareCode:'QCH123'},
    {targetOdds:'QC BASKETBALL · 19:00 WAT',shareCode:'QCB123'},
    {targetOdds:'QC HANDBALL + VOLLEYBALL · 19:00 WAT',shareCode:'QCHV123'},
    {targetOdds:'LIVE ALL SPORTS 85% · 19:00 WAT',shareCode:'LIVE123'},
  );
  for (const plan of ['free','pro','elite']) {
    const text = ctx.render(snapshot,{id:plan});
    assert.match(text,/SAFE123/);
    for (const code of ['QCF123','QCH123','QCB123','QCHV123','LIVE123']) assert.ok(text.includes(code));
    assert.doesNotMatch(text,/TWO123|THREE123|HOCKEY1000|BASKET1000|HVB1000|Pro\/Elite only/);
  }
});
