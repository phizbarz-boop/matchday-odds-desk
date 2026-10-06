'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fork} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function server(t, mode) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sporty-session-api-'));
  const sessionFile = path.join(folder, 'session.json');
  if (mode === 'browser') fs.writeFileSync(sessionFile, JSON.stringify({token:'stale-persisted-bearer',
    cookies:[['accessToken', {value:'stale-persisted-cookie', expiresAt:null}]]}));
  const child = fork(path.join(__dirname, 'fixtures/session-auth-api-server.js'), [], {cwd:path.join(__dirname, '..'), silent:true,
    env:{...process.env, NODE_ENV:'production', PORT:'0', REDIS_URL:'', HTTPS_PROXY:'', SPORTYBET_PROXY_URL:'',
      SPORTYBET_SESSION_FILE:sessionFile, SPORTYBET_ENDPOINT_LOGIN:'', SPORTYBET_ENDPOINT_LOGIN_CANDIDATES:'',
      SPORTYBET_PHONE:'2348000000000', SPORTYBET_PASSWORD:'mock-test-password',
      SPORTYBET_BOOTSTRAP_COOKIES:mode === 'browser' ? 'accessToken=fresh-browser-token; refreshToken=fresh-refresh; deviceId=fresh-device' : '',
      SPORTYBET_LIVE_MAX_PAGES:'1', SESSION_TEST_MODE:mode, WEBSITE_ACCESS_CODE:''}});
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(() => { child.kill(); fs.rmSync(folder, {recursive:true, force:true}); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not start: ' + logs)), 10000);
    child.once('message', message => { clearTimeout(timer); resolve(message.port); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Test server exited ' + code + ': ' + logs)); });
  });
  const post = async (route, body) => {
    const result = await fetch(`http://127.0.0.1:${port}${route}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    return {status:result.status, body:await result.json()};
  };
  const state = () => new Promise(resolve => {
    const id = 'session-state';
    const handler = message => { if (message.id === id) { child.off('message', handler); resolve(message.state); } };
    child.on('message', handler); child.send({type:'state', id});
  });
  return {post, state};
}
const request = {sports:['football'], liveMode:'quick_cash', minProbability:0, targetOdds:1.05, maxSelections:1, betTypes:['home_win']};

test('production Auto Analyser reports one shared login failure instead of empty markets', async t => {
  const api = await server(t, 'rejected');
  const result = await api.post('/api/sportybet/auto-pick', request);
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(result.body.code, 'SPORTYBET_AUTH_FAILED');
  assert.match(result.body.error, /dummy account session needs renewal/);
  assert.match(result.body.detail, /bizCode 12000/);
  assert.doesNotMatch(result.body.detail, /mock-test-password|2348000000000/);
  assert.equal(result.body.cornerDiagnostics, undefined);
  const retry = await api.post('/api/sportybet/auto-pick', request);
  assert.equal(retry.status, 503);
  assert.ok(retry.body.retryAt);
  assert.deepEqual(await api.state(), {logins:1, ciphers:1, accountChecks:0, marketReads:0, bookings:0});
});

test('browser bootstrap validates the dummy once, reads live markets and creates a code over the authenticated session', async t => {
  const api = await server(t, 'browser');
  const result = await api.post('/api/sportybet/auto-pick', request);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.selections.length);
  assert.ok(result.body.selections.every(s => s.live && s.quickCash));
  const booking = await api.post('/api/sportybet/book', {selections:result.body.selections});
  assert.equal(booking.status, 200, JSON.stringify(booking.body));
  assert.equal(booking.body.shareCode, 'SESSION-TEST-CODE');
  const state = await api.state();
  assert.equal(state.logins, 0); assert.equal(state.ciphers, 0); assert.equal(state.accountChecks, 1);
  assert.ok(state.marketReads > 0); assert.equal(state.bookings, 1);
});
