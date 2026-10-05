// Login + keep-alive endpoint self-heal. SportyBet moved its account service
// (/users/login 404s; account info now lives under /api/ng/patron/...), so the
// login path and the keep-alive ping must self-heal from candidate lists the
// same way the public data endpoints do.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sportybetDirect.js'), 'utf8');

test('login candidates include patron variants and env override', () => {
  assert.match(SRC, /SPORTYBET_ENDPOINT_LOGIN_CANDIDATES/);
  assert.match(SRC, /'\/patron\/login'/);
  assert.match(SRC, /'\/patron\/account\/login'/);
  assert.match(SRC, /'\/users\/v2\/login'/);
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
