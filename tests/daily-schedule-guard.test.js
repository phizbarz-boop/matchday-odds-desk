'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { watDateKey, watMinuteOfDay } = require('../lib/dailyScheduleGuard');
const root = path.join(__dirname, '..');

function workflow(name) {
  return fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
}

test('WAT calendar date remains timezone-correct for daily deduplication', () => {
  assert.equal(watDateKey(new Date('2026-09-17T23:00:00Z')), '2026-09-18');
  assert.equal(watMinuteOfDay(new Date('2026-09-18T07:25:00Z')), 505);
});

test('one CopyHub-style daily workflow refreshes all six sports; old sport workflows are manual-only', () => {
  const daily = workflow('refresh.yml');
  assert.match(daily, /Plot207 All Sports Daily Predictions/);
  assert.match(daily, /cron: ['"]20 6 \* \* \*['"]/);
  assert.match(daily, /workflow_dispatch/);
  assert.match(daily, /cancel-in-progress:\s*false/);
  assert.match(daily, /node-version:\s*['"]20['"]/);
  assert.match(daily, /playwright@1\.55\.0/);
  assert.match(daily, /node jobs\/all-sports-daily-refresh\.js/);

  const orchestrator = fs.readFileSync(path.join(root, 'jobs/all-sports-daily-refresh.js'), 'utf8');
  for (const required of [
    '/api/refresh',
    '/api/refresh/sport/basketball',
    '/api/refresh/sport/hockey',
    'sporty-handball-network-collector.js',
    'sporty-volleyball-network-collector.js',
    'sporty-tennis-network-collector.js',
    'wait-for-predictions.js',
  ]) assert.match(orchestrator, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  for (const file of [
    'basketball-daily-predictions.yml',
    'ice-hockey-daily-predictions.yml',
    'handball-network-collector-v4.yml',
    'volleyball-network-collector-v1.yml',
    'tennis-network-collector-v4.yml',
  ]) {
    const text = workflow(file);
    assert.match(text, /workflow_dispatch/, `${file} should remain available for manual recovery`);
    assert.doesNotMatch(text, /cron:/, `${file} must not run on an automatic schedule`);
  }

  const telegram = workflow('telegram-picks.yml');
  assert.match(telegram, /cron: ['"]25 7 \* \* \*['"]/);
});

test('Basketball and Hockey daily refresh endpoint is protected and force-refreshes snapshots', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /\/api\/refresh\/sport\/:sport/);
  assert.match(server, /\['basketball', 'hockey'\]/);
  assert.match(server, /forceRefresh:\s*true/);
  assert.match(server, /x-refresh-secret/);
  assert.match(server, /const forceRefresh = options\.forceRefresh === true/);
});

test('Telegram keeps the scheduled daily lock but allows manual bypass', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /telegram:daily-picks:once:/);
  assert.match(server, /x-telegram-job-secret/);
  assert.match(server, /if \(manual\)[\s\S]*Bypassing daily send lock/);
  assert.match(workflow('telegram-picks.yml'), /x-matchday-run-mode: \$MODE/);
});
