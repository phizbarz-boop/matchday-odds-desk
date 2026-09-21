'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { watDateKey, watMinuteOfDay } = require('../lib/dailyScheduleGuard');
const root = path.join(__dirname, '..');
test('WAT calendar date remains timezone-correct for daily deduplication', () => {
  assert.equal(watDateKey(new Date('2026-09-17T23:00:00Z')), '2026-09-18');
  assert.equal(watMinuteOfDay(new Date('2026-09-18T07:25:00Z')), 505);
});
test('GitHub cron schedules one refresh at 07:20 WAT and Telegram at 08:25 WAT', () => {
  const refresh = fs.readFileSync(path.join(root, '.github/workflows/refresh.yml'), 'utf8');
  const telegram = fs.readFileSync(path.join(root, '.github/workflows/telegram-picks.yml'), 'utf8');
  assert.match(refresh, /cron: ['"]20 6 \* \* \*['"]/);
  assert.match(telegram, /cron: ['"]25 7 \* \* \*['"]/);
  assert.match(refresh, /workflow_dispatch/);
  assert.match(telegram, /workflow_dispatch/);
  assert.doesNotMatch(refresh, /github\.event\.schedule/);
  assert.doesNotMatch(telegram, /github\.event\.schedule/);
});
test('Authenticated endpoints have no time-window restriction but Telegram keeps its daily lock', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /isScheduledTime|TELEGRAM_WRONG_TIME|REFRESH_WRONG_TIME/);
  assert.match(server, /telegram:daily-picks:once:/);
  assert.match(server, /x-telegram-job-secret/);
  assert.match(server, /x-refresh-secret/);
});
