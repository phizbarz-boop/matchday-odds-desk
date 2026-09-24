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

test('the actual daily runner uses 85% for SAFE and 80% for 2x/3x', async () => {
  const runner = mockRunner(testCandidates());
  let started = 0;
  const result = await runner.run({onPostingStart: () => {started++;}});
  assert.equal(started, 1);
  assert.deepEqual(Array.from(result.plans, p => p.target), ['1.30–5.00 SAFE','2','3']);
  assert.deepEqual(Array.from(result.plans, p => p.minProbability), [85,80,80]);
  assert.equal(runner.bookings.length, 3);
  assert.equal(runner.tracked.length, 3);
  assert.equal(runner.stored.at(-1).codes.length, 3);
  assert.match(runner.messages[0], /SAFE • 2x • 3x/);
  assert.doesNotMatch(runner.messages[0], /10x|20x|1000x|10000x/);
  for (const ticket of result.results) {
    assert.ok(ticket.shareCode);
    const floor = ticket.targetOdds === '1.30–5.00 SAFE' ? 85 : 80;
    assert.ok(ticket.minimumProbability === undefined || ticket.minimumProbability >= floor);
    assert.ok(ticket.combinedOdds >= (ticket.targetOdds === '2' ? 2 : ticket.targetOdds === '3' ? 3 : 1.3));
  }
});

test('84% candidates skip SAFE but can still build 2x and 3x', async () => {
  const runner = mockRunner(testCandidates(84));
  const result = await runner.run();
  assert.deepEqual(Array.from(result.results, p => p.targetOdds), ['1.30–5.00 SAFE','2','3']);
  assert.match(result.results[0].error, /No selections met the 85%/);
  assert.equal(result.results[1].shareCode, 'TEST1');
  assert.equal(result.results[2].shareCode, 'TEST2');
  assert.equal(runner.bookings.length, 2);
});

test('the daily runner rejects an entirely below-80% candidate pool', async () => {
  const runner = mockRunner(testCandidates(79));
  const result = await runner.run();
  assert.equal(runner.bookings.length, 0);
  assert.deepEqual(Array.from(result.results, p => p.targetOdds), ['1.30–5.00 SAFE','2','3']);
  assert.match(result.results[0].error, /No selections met the 85%/);
  assert.match(result.results[1].error, /No selections met the 80%/);
  assert.match(result.results[2].error, /No selections met the 80%/);
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
