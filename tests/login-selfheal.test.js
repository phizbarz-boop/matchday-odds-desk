// Login + keep-alive endpoint self-heal. SportyBet moved its account service
// (/users/login 404s; account info now lives under /api/ng/patron/...), so the
// login path and the keep-alive ping must self-heal from candidate lists the
// same way the public data endpoints do.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sportybetDirect.js'), 'utf8');

test('login candidates include the observed patron accessToken path', () => {
  assert.match(SRC, /SPORTYBET_ENDPOINT_LOGIN_CANDIDATES/);
  assert.match(SRC, /'\/patron\/accessToken'/);
  assert.match(SRC, /'\/patron\/login'/);
  assert.match(SRC, /'\/users\/v2\/login'/);
});

test('all API requests carry the web client headers and a deviceId cookie', () => {
  assert.match(SRC, /function ensureDeviceId\(\)/);
  assert.match(SRC, /'clientid': String\(process\.env\.SPORTYBET_CLIENT_ID \|\| 'web'\)/);
  assert.match(SRC, /'platform': String\(process\.env\.SPORTYBET_PLATFORM \|\| 'web'\)/);
  assert.match(SRC, /'Cookie': cookieHeader\(\)/);
  assert.match(SRC, /session\.cookies\.set\('deviceId'/);
});

test('userInfo defaults to the observed patron account-info path', () => {
  assert.match(SRC, /SPORTYBET_ENDPOINT_USERINFO \|\| '\/patron\/account\/info'/);
  assert.match(SRC, /SPORTYBET_ENDPOINT_USERINFO_CANDIDATES/);
});

test('login probes candidates and adopts the first non-404 path', () => {
  assert.match(SRC, /for \(const candidatePath of orderedLogin\)/);
  assert.match(SRC, /resolvedEndpoints\.set\('login', usedLoginPath\)/);
  assert.match(SRC, /Number\(probePayload\.bizCode\) === 19001/);
  assert.match(SRC, /login endpoint resolved to/);
});

test('failed login resolution backs off instead of hammering every keep-alive tick', () => {
  assert.match(SRC, /failedResolutionUntil\.get\('login'\)/);
  assert.match(SRC, /failedResolutionUntil\.set\('login', Date\.now\(\) \+ RESOLUTION_FAILURE_TTL_MS\)/);
});

test('keep-alive pings userInfo through the self-healing resolver', () => {
  assert.match(SRC, /requestWithResolution\('userInfo', \{ auth: true, timeoutMs: 10000 \}\)/);
});

test('geo or bot blocks still abort login probing immediately', () => {
  assert.match(SRC, /if \(isHtml\) throw classifyHtmlBlock\(url, text\)/);
});

test('patron cipher + encrypted accessToken login flow is implemented', () => {
  assert.match(SRC, /SPORTYBET_ENDPOINT_CIPHER \|\| '\/patron\/cipher'/);
  assert.match(SRC, /encryptLoginPayload/);
  assert.match(SRC, /createCipheriv\('aes-128-cbc'/);
  assert.match(SRC, /\/\\\/accessToken\$\/\.test\(candidatePath\)/);
});

test('refresh token rotation via patron/refresh is available', () => {
  assert.match(SRC, /SPORTYBET_ENDPOINT_REFRESH \|\| '\/patron\/refresh'/);
  assert.match(SRC, /async function refreshSession\(\)/);
  assert.match(SRC, /Access token rotated via patron\/refresh/);
  assert.match(SRC, /trying token refresh/);
});

test('browser cookie bootstrap via SPORTYBET_BOOTSTRAP_COOKIES', () => {
  assert.match(SRC, /function bootstrapCookiesFromEnv\(\)/);
  assert.match(SRC, /process\.env\.SPORTYBET_BOOTSTRAP_COOKIES/);
  assert.match(SRC, /Bootstrapped \$\{added\} cookies/);
});

test('keep-alive can run on bootstrap cookies without a password', () => {
  assert.match(SRC, /!credentialsConfigured\(\) && !process\.env\.SPORTYBET_BOOTSTRAP_COOKIES/);
});
