'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Exercise the real route handler without HTTP, Telegram, or Redis network calls.
// The handler is registered with a minimal Express stub and an in-memory Redis
// implementation, so cancellation and the compare-and-delete lock are tested.
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = server.indexOf("app.post('/api/telegram/daily-picks',");
const end = server.indexOf("\napp.post('/api/telegram/test',", begin);
assert.ok(begin !== -1 && end > begin, 'Telegram daily-picks route must exist');
const routeSource = server.slice(begin, end);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function fakeRedis() {
  const data = new Map();
  return {
    data,
    async set(key, value, options = {}) {
      if (options.NX && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    },
    async get(key) { return data.get(key) ?? null; },
    async exists(key) { return Number(data.has(key)); },
    async eval(_script, { keys, arguments: args }) {
      if (data.get(keys[0]) !== args[0]) return 0;
      data.delete(keys[0]);
      return 1;
    },
  };
}
function response() {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.statusCode = 200;
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => {
    res.body = body;
    res.writableEnded = true;
    res.emit('close');
    return res;
  };
  res.disconnect = () => { res.destroyed = true; res.emit('close'); };
  return res;
}
function createHarness(runTelegramDailyPicks) {
  const redis = fakeRedis();
  let handler;
  const context = {
    app: { post(route, _middleware, fn) { assert.equal(route, '/api/telegram/daily-picks'); handler = fn; } },
    express: { json: () => () => {} },
    process: { env: { TELEGRAM_JOB_SECRET: 'test-secret' } },
    crypto: { randomUUID: () => `token-${Math.random()}` },
    watDateKey: () => '2026-09-18',
    isScheduledTime: () => true,
    getRedis: async () => redis,
    runTelegramDailyPicks,
    console: { log() {}, warn() {}, error() {} },
    Date, JSON, Promise, String,
  };
  vm.runInNewContext(routeSource, context);
  return {
    redis,
    start: (res = response(), mode = 'scheduled') => {
      const req = { headers: { 'x-telegram-job-secret': 'test-secret', 'x-matchday-run-mode': mode } };
      return { res, done: handler(req, res) };
    },
  };
}
async function tick() { await new Promise(resolve => setImmediate(resolve)); }

const lock = 'telegram:daily-picks:once:2026-09-18';
const status = 'telegram:daily-picks:status:2026-09-18';

test('cancel before posting releases only its own daily lock and prevents sending', async () => {
  const entered = deferred(), continueBuild = deferred();
  let posts = 0;
  const h = createHarness(async ({ shouldAbort, onPostingStart }) => {
    entered.resolve();
    await continueBuild.promise;
    if (shouldAbort()) {
      const err = new Error('cancelled'); err.code = 'TELEGRAM_CANCELLED_BEFORE_POST';
      throw err;
    }
    await onPostingStart(); posts += 1;
    return { results: [] };
  });
  const { res, done } = h.start();
  await entered.promise;
  assert.equal(await h.redis.exists(lock), 1);
  res.disconnect();
  continueBuild.resolve();
  await done;
  assert.equal(posts, 0, 'a canceled build must never start Telegram posting');
  assert.equal(await h.redis.exists(lock), 0, 'canceled unsent run must unlock');
  assert.equal(JSON.parse(await h.redis.get(status)).status, 'cancelled_before_post');
});

test('cancel after posting begins keeps the once-per-day lock', async () => {
  const posting = deferred(), finish = deferred();
  let posts = 0;
  const h = createHarness(async ({ onPostingStart }) => {
    await onPostingStart(); posts += 1; posting.resolve();
    await finish.promise;
    return { results: [] };
  });
  const { res, done } = h.start();
  await posting.promise;
  res.disconnect();
  await tick();
  assert.equal(await h.redis.exists(lock), 1);
  finish.resolve();
  await done;
  assert.equal(posts, 1);
  assert.equal(await h.redis.exists(lock), 1);
  assert.equal(JSON.parse(await h.redis.get(status)).status, 'completed');
});

test('second scheduled request reports HTTP 409 rather than pretending to have sent picks', async () => {
  let calls = 0;
  const h = createHarness(async ({ onPostingStart }) => {
    calls += 1;
    await onPostingStart();
    return { results: [] };
  });
  await h.start().done;
  const second = h.start();
  await second.done;
  assert.equal(second.res.statusCode, 409);
  assert.equal(second.res.body.code, 'TELEGRAM_ALREADY_STARTED_OR_SENT');
  assert.equal(second.res.body.runStatus, 'completed');
  assert.equal(calls, 1, 'a second attempt must not send again');
});



test('manual workflow runs bypass the daily lock and can be repeated anytime', async () => {
  let calls = 0;
  const h = createHarness(async ({ onPostingStart }) => {
    calls += 1;
    await onPostingStart();
    return { results: [] };
  });
  const first = h.start(response(), 'manual');
  await first.done;
  const second = h.start(response(), 'manual');
  await second.done;
  assert.equal(first.res.statusCode, 200);
  assert.equal(second.res.statusCode, 200);
  assert.equal(first.res.body.runMode, 'manual');
  assert.equal(second.res.body.runMode, 'manual');
  assert.equal(calls, 2, 'each manual workflow dispatch should generate and send again');
  assert.equal(await h.redis.exists(lock), 0, 'manual runs must not consume the scheduled daily lock');
});

test('pre-post failures unlock and allow a fresh manual retry', async () => {
  let calls = 0;
  const h = createHarness(async ({ onPostingStart }) => {
    calls += 1;
    if (calls === 1) throw new Error('fixture load failed before sending');
    await onPostingStart();
    return { results: [] };
  });
  const first = h.start();
  await first.done;
  assert.equal(first.res.statusCode, 502);
  assert.equal(await h.redis.exists(lock), 0);
  const second = h.start();
  await second.done;
  assert.equal(second.res.statusCode, 200);
  assert.equal(calls, 2);
});

test('the actual picker rechecks cancellation after loading candidates and before posting', () => {
  const load = server.indexOf('const globalCandidates = await loadAutoCandidates(', 0);
  const endLoad = server.indexOf('  assertNotCancelled();', load);
  const startPosting = server.indexOf('  await onPostingStart();', endLoad);
  assert.ok(load > -1 && endLoad > load && startPosting > endLoad);
  assert.match(server.slice(endLoad, startPosting), /assertNotCancelled\(\);[\s\S]*saveTelegramDailyCodes[\s\S]*assertNotCancelled\(\);/);
});
