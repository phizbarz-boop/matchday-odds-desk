'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { watDateKey, watMinuteOfDay, isScheduledTime } = require('../lib/dailyScheduleGuard');
const at = s => new Date(s);
test('WAT date rollover follows Nigeria time, not UTC date', () => {
  assert.equal(watDateKey(at('2026-09-17T23:00:00Z')), '2026-09-18');
  assert.equal(watDateKey(at('2026-09-18T00:18:00Z')), '2026-09-18');
});
test('refresh only allowed around 07:00 WAT', () => {
  assert.equal(watMinuteOfDay(at('2026-09-18T06:00:00Z')), 420);
  assert.equal(isScheduledTime('refresh', at('2026-09-18T05:59:00Z')), false);
  assert.equal(isScheduledTime('refresh', at('2026-09-18T06:00:00Z')), true);
  assert.equal(isScheduledTime('refresh', at('2026-09-18T07:14:00Z')), true);
  assert.equal(isScheduledTime('refresh', at('2026-09-18T07:15:00Z')), false);
  assert.equal(isScheduledTime('refresh', at('2026-09-18T00:18:00Z')), false);
});
test('Telegram single daily window starts 08:30 WAT; overnight and evening excluded', () => {
  assert.equal(watMinuteOfDay(at('2026-09-18T07:30:00Z')), 510);
  assert.equal(isScheduledTime('telegram', at('2026-09-18T07:29:00Z')), false);
  assert.equal(isScheduledTime('telegram', at('2026-09-18T07:30:00Z')), true);
  assert.equal(isScheduledTime('telegram', at('2026-09-18T08:29:00Z')), true);
  assert.equal(isScheduledTime('telegram', at('2026-09-18T08:30:00Z')), false);
  assert.equal(isScheduledTime('telegram', at('2026-09-18T00:18:00Z')), false);
  assert.equal(isScheduledTime('telegram', at('2026-09-17T17:38:00Z')), false);
});
