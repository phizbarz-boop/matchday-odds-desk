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

test('all six sports have independent automatic daily workflows', () => {
  const schedules = [
    ['refresh.yml', /cron: ['"]5 6 \* \* \*['"]/, 'Football'],
    ['basketball-daily-predictions.yml', /cron: ['"]10 6 \* \* \*['"]/, 'Basketball'],
    ['ice-hockey-daily-predictions.yml', /cron: ['"]15 6 \* \* \*['"]/, 'Ice Hockey'],
    ['handball-network-collector-v4.yml', /cron: ['"]20 6 \* \* \*['"]/, 'Handball'],
    ['volleyball-network-collector-v1.yml', /cron: ['"]25 6 \* \* \*['"]/, 'Volleyball'],
    ['tennis-network-collector-v4.yml', /cron: ['"]30 6 \* \* \*['"]/, 'Tennis'],
  ];

  for (const [file, cron, sport] of schedules) {
    const text = workflow(file);
    assert.match(text, cron, `${sport} should have its own daily cron`);
    assert.match(text, /workflow_dispatch/, `${sport} should also support manual recovery`);
    assert.match(text, new RegExp(sport.replace(' ', '\\s+'), 'i'));
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

test('Telegram keeps its daily lock', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /telegram:daily-picks:once:/);
  assert.match(server, /x-telegram-job-secret/);
});
