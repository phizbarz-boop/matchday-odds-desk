'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {bootstrapLine} = require('../jobs/sporty-session-bootstrap');

function response(payload, cookies = [], status = 200) {
  return {ok:status >= 200 && status < 300, status,
    headers:{get:name => name === 'content-type' ? 'application/json' : null, getSetCookie:() => cookies},
    text:async () => JSON.stringify(payload)};
}
function client(t, env = {}, saved) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sporty-session-test-'));
  const vars = {REDIS_URL:'', SPORTYBET_PHONE:'', SPORTYBET_PASSWORD:'', SPORTYBET_BOOTSTRAP_COOKIES:'',
    SPORTYBET_PROXY_URL:'', HTTPS_PROXY:'', SPORTYBET_LOGIN_EXTRA:'', SPORTYBET_ENDPOINT_LOGIN:'/patron/login',
    SPORTYBET_ENDPOINT_LOGIN_CANDIDATES:'', SPORTYBET_ENDPOINT_USERINFO:'',
    SPORTYBET_SESSION_FILE:path.join(folder, 'session.json'), ...env};
  const prior = Object.fromEntries(Object.keys(vars).map(name => [name, process.env[name]]));
  Object.assign(process.env, vars);
  if (saved) fs.writeFileSync(vars.SPORTYBET_SESSION_FILE, JSON.stringify(saved));
  const filename = require.resolve('../lib/sportybetDirect');
  delete require.cache[filename];
  const direct = require(filename);
  t.after(() => {
    direct.setFetchForTesting(null);
    delete require.cache[filename];
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(folder, {recursive:true, force:true});
  });
  return {direct, filename, file:vars.SPORTYBET_SESSION_FILE};
}
const credentials = {SPORTYBET_PHONE:'2348000000000', SPORTYBET_PASSWORD:'mock-password-only'};
const jwt = exp => `header.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.signature`;

test('HTTP 200 rejected login never becomes authenticated, even with an access cookie', async t => {
  const {direct} = client(t, credentials);
  let calls = 0;
  direct._session.cookies.set('deviceId', {value:'existing-browser-device', expiresAt:null});
  direct.setFetchForTesting(async (_url, options) => {
    calls++;
    assert.match(options.headers.Cookie, /deviceId=existing-browser-device/);
    return response({bizCode:12000, innerMsg:'failure', message:'Looks like we’re having trouble on our end. Please try again later.'}, ['accessToken=untrusted-cookie; Max-Age=3600']);
  });
  await assert.rejects(direct.login(), error => error.code === 'SPORTYBET_AUTH_FAILED' && error.bizCode === 12000 && /rejected.*login/.test(error.message));
  assert.equal(direct.hasAuthenticatedSession(), false);
  assert.equal(direct.sessionStatus().loginCount, 0);
  assert.ok(direct.sessionStatus().nextLoginRetryAt);
  await assert.rejects(direct.login({force:true}), /Next automatic login retry/);
  assert.equal(calls, 1);
});

test('32 concurrent market families share one failed login and perform no board reads', async t => {
  const {direct} = client(t, credentials);
  let logins = 0, boards = 0;
  direct.setFetchForTesting(async url => {
    if (new URL(url).pathname.endsWith('/patron/login')) { logins++; return response({bizCode:12000, message:'Login rejected'}); }
    boards++; throw new Error('A rejected session must not read the board');
  });
  const results = await Promise.allSettled(Array.from({length:32}, (_, i) => direct.fetchPrematchPage('sr:sport:1', 1, 10, {marketIds:String(i)})));
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'SPORTYBET_AUTH_FAILED'));
  assert.equal(logins, 1); assert.equal(boards, 0);
  await assert.rejects(direct.fetchLivePage('sr:sport:1', 1, 10), /Next automatic login retry/);
  assert.equal(logins, 1);
});

test('default login tries patron/accessToken before a persisted legacy users/login path', async t => {
  const {direct} = client(t, {...credentials, SPORTYBET_ENDPOINT_LOGIN:''}, {resolvedEndpoints:{login:'/users/login'}});
  const paths = [];
  direct.setFetchForTesting(async url => {
    const pathname = new URL(url).pathname; paths.push(pathname);
    if (pathname.endsWith('/patron/cipher')) return response({bizCode:10000, data:{password:Buffer.alloc(16, 1).toString('base64'), ursId:'mock-cipher-id'}});
    return response({bizCode:12000, message:'Rejected test ciphertext'});
  });
  // This proves ordering and strict rejection, not compatibility of the
  // unverified legacy cipher with a real SportyBet password login.
  await assert.rejects(direct.login(), /Rejected test ciphertext/);
  assert.deepEqual(paths, ['/api/ng/patron/cipher', '/api/ng/patron/accessToken']);
});

test('changed browser bootstrap replaces stale persisted cookies and bearer token', async t => {
  const {direct, file} = client(t, {SPORTYBET_BOOTSTRAP_COOKIES:'accessToken=fresh-browser-token; refreshToken=fresh-refresh; deviceId=browser-device'}, {
    token:'stale-bearer-token', cookies:[['accessToken', {value:'stale-cookie', expiresAt:null}], ['deviceId', {value:'old-device', expiresAt:null}]],
  });
  direct.setFetchForTesting(async (url, options) => {
    assert.ok(url.endsWith('/patron/account/info'));
    assert.match(options.headers.Cookie, /accessToken=fresh-browser-token/);
    assert.match(options.headers.Cookie, /deviceId=browser-device/);
    assert.equal(options.headers.authorization, undefined);
    return response({bizCode:10000, data:{userId:'mock-dummy'}});
  });
  await direct.ensureSession({validate:true});
  assert.ok(direct.sessionStatus().lastAuthenticatedAt);
  assert.equal(direct._session.token, null);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.bootstrapFingerprint);
  assert.equal(saved.cookies.find(([name]) => name === 'refreshToken')[1].value, 'fresh-refresh');
});

test('unchanged bootstrap preserves a newer rotated persisted session after restart', async t => {
  const raw = 'accessToken=older-bootstrap; refreshToken=older-refresh; deviceId=browser-device';
  const {direct} = client(t, {SPORTYBET_BOOTSTRAP_COOKIES:raw}, {
    bootstrapFingerprint:crypto.createHash('sha256').update(raw).digest('hex'), token:'rotated-token',
    cookies:[['accessToken', {value:'rotated-token', expiresAt:Date.now()+60000}], ['refreshToken', {value:'rotated-refresh', expiresAt:null}]],
  });
  direct.setFetchForTesting(async (_url, options) => {
    assert.match(options.headers.Cookie, /accessToken=rotated-token/);
    assert.doesNotMatch(options.headers.Cookie, /older-bootstrap/);
    return response({bizCode:10000, data:{userId:'mock'}});
  });
  await direct.ensureSession({validate:true});
  assert.equal(direct._session.token, 'rotated-token');
});

test('expired JWT credentials refresh once for concurrent requests without a password login', async t => {
  const expired = jwt(Math.floor(Date.now()/1000)-60);
  const {direct} = client(t, {}, {token:expired, cookies:[['accessToken', {value:expired, expiresAt:null}], ['refreshToken', {value:'working-refresh', expiresAt:null}]]});
  let refreshes = 0, checks = 0;
  direct.setFetchForTesting(async url => {
    if (url.endsWith('/patron/refresh')) { refreshes++; return response({bizCode:10000}, ['accessToken=rotated-token; Max-Age=3600']); }
    assert.ok(url.endsWith('/patron/account/info')); checks++;
    return response({bizCode:10000, data:{userId:'mock'}});
  });
  await Promise.all(Array.from({length:20}, () => direct.ensureSession({validate:true})));
  assert.equal(refreshes, 1); assert.equal(checks, 1);
  assert.equal(direct._session.token, 'rotated-token');
});

test('authenticated GET retries inside the original promise after a 401', {timeout:2000}, async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.cookies.set('accessToken', {value:'expired-server-side', expiresAt:null});
  direct._session.cookies.set('refreshToken', {value:'working-refresh', expiresAt:null});
  let reads = 0, refreshes = 0;
  direct.setFetchForTesting(async (url, options) => {
    if (url.endsWith('/patron/refresh')) { refreshes++; return response({bizCode:10000}, ['accessToken=rotated-token; Max-Age=60']); }
    reads++;
    if (reads === 1) return response({message:'Unauthorized'}, [], 401);
    assert.match(options.headers.Cookie, /accessToken=rotated-token/);
    return response({bizCode:10000, data:{ready:true}});
  });
  const result = await direct.sportyRequest('/patron/account/info', {auth:true});
  assert.equal(result.data.ready, true); assert.equal(reads, 2); assert.equal(refreshes, 1);
});

test('HTTP 200 expired-session business errors renew and retry once', {timeout:2000}, async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.cookies.set('accessToken', {value:'old-token', expiresAt:null});
  direct._session.cookies.set('refreshToken', {value:'refresh', expiresAt:null});
  let reads = 0;
  direct.setFetchForTesting(async url => {
    if (url.endsWith('/patron/refresh')) return response({bizCode:10000, data:{accessToken:'new-rotated-token'}});
    return ++reads === 1 ? response({bizCode:11000, message:'Access token expired'}) : response({bizCode:10000, data:['current']});
  });
  const result = await direct.sportyRequest('/factsCenter/liveOrPrematchEvents', {auth:true});
  assert.deepEqual(result.data, ['current']); assert.equal(reads, 2);
});

test('different concurrent authenticated GETs share one token renewal', {timeout:2000}, async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.cookies.set('accessToken', {value:'old-token', expiresAt:null});
  direct._session.cookies.set('refreshToken', {value:'refresh', expiresAt:null});
  let refreshes = 0, oldReads = 0;
  let release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  direct.setFetchForTesting(async (url, options) => {
    if (url.endsWith('/patron/refresh')) { refreshes++; return response({bizCode:10000}, ['accessToken=new-token; Max-Age=60']); }
    if (options.headers.Cookie.includes('accessToken=old-token')) {
      if (++oldReads === 2) release(); await bothStarted;
      return response({message:'Unauthorized'}, [], 401);
    }
    return response({bizCode:10000, data:{ready:true}});
  });
  const results = await Promise.all([1, 2].map(i => direct.sportyRequest('/patron/account/info', {auth:true, params:{request:i}})));
  assert.ok(results.every(r => r.data.ready)); assert.equal(refreshes, 1);
});

test('a successful refresh response without credentials cannot authenticate a visitor', async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.cookies.set('deviceId', {value:'visitor', expiresAt:null});
  direct._session.cookies.set('refreshToken', {value:'refresh', expiresAt:null});
  direct.setFetchForTesting(async () => response({bizCode:10000, data:{}}));
  assert.equal(await direct.refreshSession(), false);
  assert.equal(direct.hasAuthenticatedSession(), false);
});

test('business errors cannot be mistaken for empty market data', async t => {
  const {direct} = client(t);
  direct.setFetchForTesting(async () => response({bizCode:12000, message:'Service unavailable'}));
  await assert.rejects(direct.sportyRequest('/factsCenter/pcUpcomingEvents'), error => error.code === 'SPORTYBET_API' && error.bizCode === 12000);
});

test('signed-out Set-Cookie deletes the credential, including combined headers with Expires commas', async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.token = 'old-token';
  direct._session.cookies.set('accessToken', {value:'old-token', expiresAt:null});
  direct.setFetchForTesting(async () => ({ok:true, status:200,
    headers:{get:name => name === 'content-type' ? 'application/json' : name === 'set-cookie'
      ? 'accessToken=old-token; Max-Age=-1, deviceId=kept; Expires=Wed, 21 Oct 2037 07:28:00 GMT, refreshToken=fresh; Max-Age=60' : null},
    text:async () => JSON.stringify({bizCode:10000})}));
  await direct.sportyRequest('/factsCenter/pcUpcomingEvents');
  assert.equal(direct.hasAuthenticatedSession(), false);
  assert.equal(direct._session.cookies.get('deviceId').value, 'kept');
  assert.equal(direct._session.cookies.get('refreshToken').value, 'fresh');
});

test('refresh replaces a stale cookie when new credentials arrive only in the response body', async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.cookies.set('accessToken', {value:'expired-on-server', expiresAt:null});
  direct._session.cookies.set('refreshToken', {value:'refresh', expiresAt:null});
  direct.setFetchForTesting(async (url, options) => {
    if (url.endsWith('/patron/refresh')) return response({bizCode:10000, data:{accessToken:'new-response-token'}});
    assert.match(options.headers.Cookie, /accessToken=new-response-token/);
    assert.doesNotMatch(options.headers.Cookie, /expired-on-server/);
    return response({bizCode:10000, data:['current']});
  });
  assert.equal(await direct.refreshSession(), true);
  await direct.sportyRequest('/factsCenter/liveOrPrematchEvents', {auth:true});
  assert.equal(direct._session.token, 'new-response-token');
});

test('local session export accepts only current SportyBet auth cookies', () => {
  const cookies = [
    {domain:'.sportybet.com', name:'accessToken', value:'current-access', expires:-1},
    {domain:'.sportybet.com', name:'refreshToken', value:'current-refresh', expires:-1},
    {domain:'.sportybet.com', name:'deviceId', value:'device', expires:-1},
    {domain:'.example.com', name:'accessToken', value:'wrong-site', expires:-1},
    {domain:'.sportybet.com', name:'analytics', value:'ignored', expires:-1},
  ];
  assert.equal(bootstrapLine(cookies), 'SPORTYBET_BOOTSTRAP_COOKIES=accessToken=current-access; refreshToken=current-refresh; deviceId=device');
  assert.throws(() => bootstrapLine(cookies.map(c => c.name === 'accessToken' ? {...c, expires:1} : c)), /no usable/);
  assert.throws(() => bootstrapLine(cookies.map(c => c.name === 'refreshToken' ? {...c, value:'bad\nvalue'} : c)), /no usable/);
});
