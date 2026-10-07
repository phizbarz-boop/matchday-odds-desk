// Direct SportyBet Nigeria web client with a persistent dummy-account session.
//
// This module replaces the old Parse.bot middleman entirely:
//  - Fixtures, markets and odds come from SportyBet's web JSON endpoints.
//    When a dummy account is configured, reads require its session too.
//  - Creating booking codes requires a logged-in session. The dummy account
//    (SPORTYBET_PHONE / SPORTYBET_PASSWORD) is logged in automatically, its
//    cookies + token are persisted (Redis when REDIS_URL is set, otherwise a
//    local session file), and a keep-alive loop renews the session before it
//    expires. Refresh is attempted before automatic website-form sign-in;
//    verification prompts and rejections remain visible in diagnostics.
//  - SportyBet geo-fences its API to allowed regions. When the server IP is
//    blocked (Render US/EU), set SPORTYBET_PROXY_URL to an HTTP/SOCKS proxy
//    with a Nigerian exit. Geo-blocks are detected and reported as
//    SPORTYBET_GEO_BLOCKED instead of confusing JSON parse errors.
//
// Every endpoint path is overridable via environment variables so SportyBet
// route changes never require a code edit. See SPORTYBET_SETUP.md.
//
// Credentials stay on the server only; never expose them to public/index.html.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = String(process.env.SPORTYBET_BASE_URL || 'https://www.sportybet.com/api/ng').replace(/\/+$/, '');
const SITE_ORIGIN = String(process.env.SPORTYBET_SITE_ORIGIN || 'https://www.sportybet.com').replace(/\/+$/, '');

// Defaults match the paths observed on sportybet.com's own web app: the
// prematch list is pcUpcomingEvents?sportId=sr:sport:N&marketId=<csv>. If
// SportyBet renames a route, the client automatically probes the candidate
// list below and adopts the first path that answers (see requestWithResolution),
// so a route rename self-heals. Pin an exact path with SPORTYBET_ENDPOINT_* to
// put it first in the probe order.
const ENDPOINTS = {
  // Public data
  prematch: String(process.env.SPORTYBET_ENDPOINT_PREMATCH || '/factsCenter/pcUpcomingEvents'),
  eventDetail: String(process.env.SPORTYBET_ENDPOINT_EVENT || '/factsCenter/eventDetail'),
  // Live / in-play board (the website's "Live" tab data source).
  live: String(process.env.SPORTYBET_ENDPOINT_LIVE || '/factsCenter/liveOrPrematchEvents'),
  bookingLookup: String(process.env.SPORTYBET_ENDPOINT_BOOKING_LOOKUP || '/orders/share'),
  // Session / authenticated
  login: String(process.env.SPORTYBET_ENDPOINT_LOGIN || '/patron/accessToken'),
  // Observed on the site's own web app: account info is under /patron.
  userInfo: String(process.env.SPORTYBET_ENDPOINT_USERINFO || '/patron/account/info'),
  // Legacy API-login endpoints are used only with LOGIN_METHOD=api. Their
  // encrypted-payload format has not been verified; the default browser
  // method lets the website produce its own request. Refresh uses the saved
  // refreshToken cookie while SportyBet continues accepting it.
  cipher: String(process.env.SPORTYBET_ENDPOINT_CIPHER || '/patron/cipher'),
  refresh: String(process.env.SPORTYBET_ENDPOINT_REFRESH || '/patron/refresh'),
  bookBet: String(process.env.SPORTYBET_ENDPOINT_BOOK || '/orders/share'),
};

// Candidate paths probed, in order, until one answers with JSON (anything that
// is not a 404 "Resource not found" gateway response). Override/extend with
// comma-separated SPORTYBET_ENDPOINT_<KIND>_CANDIDATES.
function envPathList(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

const ENDPOINT_CANDIDATES = {
  prematch: envPathList('SPORTYBET_ENDPOINT_PREMATCH_CANDIDATES', [
    ENDPOINTS.prematch,
    '/factsCenter/upcomingEvents',
    '/factsCenter/prematchSportEvents',
    '/factsCenter/sportEvents',
  ]),
  live: envPathList('SPORTYBET_ENDPOINT_LIVE_CANDIDATES', [
    // Observed on the site's own web app (Oct 2026): the live board loads from
    // /api/ng/factsCenter/liveOrPrematchEvents?sportId=sr:sport:1. The feed can
    // mix in-play and upcoming events; lib/sportybet.js filters to live-only.
    ENDPOINTS.live,
    '/factsCenter/liveOrPrematchEvents',
    '/factsCenter/pcLiveEvents',
    '/factsCenter/liveEvents',
    '/factsCenter/liveSportEvents',
    '/factsCenter/inplayEvents',
    '/factsCenter/inPlayEvents',
    '/factsCenter/pcLiveSportEvents',
  ]),
  eventDetail: envPathList('SPORTYBET_ENDPOINT_EVENT_CANDIDATES', [
    ENDPOINTS.eventDetail,
    '/factsCenter/event',
    '/factsCenter/outcomes',
    '/factsCenter/preMatchEventDetail',
  ]),
  // Session / authenticated. The account service moved under /patron (the
  // site's own account-info call is /api/ng/patron/account/info), so patron
  // variants are probed early. Probing happens ONLY inside login() — never
  // from keep-alive or data requests — and each candidate is POSTed once per
  // login until one answers with something other than the gateway's 404.
  login: envPathList('SPORTYBET_ENDPOINT_LOGIN_CANDIDATES', [
    ENDPOINTS.login,
    // Observed on the site's own web app (Oct 2026): login is a JSON POST to
    // /api/ng/patron/accessToken with clientid/operid/platform headers.
    '/patron/accessToken',
    '/users/login',
    '/patron/login',
    '/patron/account/login',
    '/patron/auth/login',
    '/users/v2/login',
    '/users/v3/login',
    '/v2/users/login',
    '/auth/login',
    '/passport/login',
  ]),
  // Keep-alive ping target. Observed on the site: /api/ng/patron/account/info.
  userInfo: envPathList('SPORTYBET_ENDPOINT_USERINFO_CANDIDATES', [
    ENDPOINTS.userInfo,
    '/patron/account/info',
    '/patron/user/info',
    '/users/v2/info',
    '/account/info',
  ]),
};

// Query parameter names used by the real SportyBet web API. Observed on the
// site's own requests: sportId=sr:sport:1 and marketId=1,18,10,29,11,26,3.
// Rename via env if SportyBet ever changes them (set to empty to omit).
const PARAM_SPORT = process.env.SPORTYBET_PARAM_SPORT !== undefined ? String(process.env.SPORTYBET_PARAM_SPORT) : 'sportId';
const PARAM_MARKET = process.env.SPORTYBET_PARAM_MARKET !== undefined ? String(process.env.SPORTYBET_PARAM_MARKET) : 'marketId';
const PARAM_PAGE = process.env.SPORTYBET_PARAM_PAGE !== undefined ? String(process.env.SPORTYBET_PARAM_PAGE) : 'pageNum';
const PARAM_PAGE_SIZE = process.env.SPORTYBET_PARAM_PAGE_SIZE !== undefined ? String(process.env.SPORTYBET_PARAM_PAGE_SIZE) : 'pageSize';
const PARAM_EVENT_ID = process.env.SPORTYBET_PARAM_EVENT_ID !== undefined ? String(process.env.SPORTYBET_PARAM_EVENT_ID) : 'eventId';
// The site appends a _t cache-buster; off by default so shared/CDN caches and
// the in-flight GET dedupe keep working. Enable with SPORTYBET_CACHE_BUSTER=1.
const CACHE_BUSTER = String(process.env.SPORTYBET_CACHE_BUSTER || '') === '1';
const {sportyRequest:currentSportyRequest}=require('./sportyRequest');

const KEEPALIVE_SECONDS = Math.max(60, parseInt(process.env.SPORTYBET_KEEPALIVE_SECONDS || '240', 10) || 240);
const SESSION_FILE = String(process.env.SPORTYBET_SESSION_FILE || path.join(process.cwd(), '.sportybet-session.json'));
const SESSION_REDIS_KEY = String(process.env.SPORTYBET_SESSION_REDIS_KEY || 'sportybet:session:v1');
const REQUEST_TIMEOUT_MS = Math.max(5000, parseInt(process.env.SPORTYBET_REQUEST_TIMEOUT_MS || '20000', 10) || 20000);
const LOGIN_RETRY_MS = Math.max(1000, Number(process.env.SPORTYBET_LOGIN_RETRY_MS) || 60000);
const SESSION_CHECK_MS = Math.max(1000, Number(process.env.SPORTYBET_SESSION_CHECK_MS) || 60000);
const LOGIN_METHOD = String(process.env.SPORTYBET_LOGIN_METHOD || 'browser').toLowerCase();
const REFRESH_SECONDS = Math.max(60, Number(process.env.SPORTYBET_REFRESH_SECONDS) || 1200);
const REFRESH_MARGIN_SECONDS = Math.max(30, Number(process.env.SPORTYBET_REFRESH_MARGIN_SECONDS) || 300);
const PROXY_URL = String(process.env.SPORTYBET_PROXY_URL || process.env.HTTPS_PROXY || '').trim();

const USER_AGENT = String(process.env.SPORTYBET_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

// ---------------------------------------------------------------------------
// HTTP plumbing (undici so HTTP/SOCKS proxies work)
// ---------------------------------------------------------------------------

let undici = null;
try {
  undici = require('undici');
} catch {
  undici = null; // fall back to global fetch (no proxy support)
}

let proxyDispatcher = null;
function getDispatcher() {
  if (!PROXY_URL) return undefined;
  if (!undici || !undici.ProxyAgent) return undefined;
  if (!proxyDispatcher) {
    proxyDispatcher = new undici.ProxyAgent(PROXY_URL);
    console.log('[SportyBet] Using proxy exit for SportyBet traffic');
  }
  return proxyDispatcher;
}

// Test hook: unit tests inject a fake fetch implementation.
let fetchImpl = null;
function setFetchForTesting(fn) { fetchImpl = fn; }
let browserLoginImpl = null;
function setBrowserLoginForTesting(fn) { browserLoginImpl = fn; }

async function rawFetch(url, options = {}) {
  const impl = fetchImpl || (undici && undici.fetch) || globalThis.fetch;
  const dispatcher = getDispatcher();
  const finalOptions = { ...options };
  if (dispatcher && impl === (undici && undici.fetch)) finalOptions.dispatcher = dispatcher;
  return impl(url, finalOptions);
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function sportyError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function classifyHtmlBlock(url, text) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('page451') || lower.includes('unavailable for legal reasons') || lower.includes('451')) {
    return sportyError(
      'SportyBet geo-blocked this server IP (HTTP 451 page). Reading SportyBet directly requires an allowed-region IP: set SPORTYBET_PROXY_URL to a proxy with a Nigerian exit, or host in Nigeria.',
      'SPORTYBET_GEO_BLOCKED',
      { status: 451 }
    );
  }
  if (lower.includes('cloudflare') && (lower.includes('captcha') || lower.includes('challenge') || lower.includes('attention required'))) {
    return sportyError(
      'SportyBet/Cloudflare presented a bot challenge to this server IP. Use a cleaner proxy exit (SPORTYBET_PROXY_URL) or reduce request rate.',
      'SPORTYBET_BOT_CHALLENGE',
      { status: 403 }
    );
  }
  return sportyError(
    `SportyBet returned an HTML page instead of JSON for ${url}. The endpoint path may have changed (override it with the SPORTYBET_ENDPOINT_* variables) or the request was blocked.`,
    'SPORTYBET_NON_JSON',
    { status: 200 }
  );
}

// ---------------------------------------------------------------------------
// Session state (cookie jar + token) with Redis/file persistence
// ---------------------------------------------------------------------------

const session = {
  cookies: new Map(),      // name -> { value, expiresAt|null }
  token: null,             // bearer/access token when SportyBet returns one
  tokenHeader: 'authorization',
  tokenExpiresAt: null,
  bootstrapFingerprint: null,
  lastAuthenticatedAt: null,
  authGeneration: 0,
  loggedInAt: null,
  lastKeepAliveAt: null,
  lastKeepAliveOk: null,
  lastLoginError: null,
  lastRefreshAt: null,
  lastRefreshError: null,
  loginMethod: null,
  requiresUserAction: false,
  loginCount: 0,
  loaded: false,
};

// Resolved data-endpoint cache: kind -> path that actually answered. Seeded
// from the persisted session so a restart does not re-probe; a later 404 on
// the resolved path drops it and triggers re-resolution (route-rename heal).
const resolvedEndpoints = new Map();

function candidatesFor(kind) {
  const seen = new Set();
  return (ENDPOINT_CANDIDATES[kind] || []).filter(p => {
    const v = String(p || '').trim();
    if (!v || seen.has(v)) return false;
    seen.add(v);
    return true;
  });
}

let persistRedisTried = false;
let persistRedis = null;
async function getPersistRedis() {
  if (persistRedisTried) return persistRedis;
  persistRedisTried = true;
  if (!process.env.REDIS_URL) return null;
  try {
    const { createClient } = require('redis');
    persistRedis = createClient({ url: process.env.REDIS_URL });
    persistRedis.on('error', () => {});
    await persistRedis.connect();
  } catch (err) {
    console.warn('[SportyBet session] Redis persistence unavailable, using session file:', err.message);
    persistRedis = null;
  }
  return persistRedis;
}

function serializeSession() {
  return JSON.stringify({
    cookies: [...session.cookies.entries()],
    token: session.token,
    tokenHeader: session.tokenHeader,
    tokenExpiresAt: session.tokenExpiresAt,
    bootstrapFingerprint: session.bootstrapFingerprint,
    loggedInAt: session.loggedInAt,
    lastRefreshAt: session.lastRefreshAt,
    loginMethod: session.loginMethod,
    resolvedEndpoints: Object.fromEntries(resolvedEndpoints),
    savedAt: new Date().toISOString(),
  });
}

let sessionWrite=Promise.resolve();
function persistSession() {
  const next=sessionWrite.then(async()=>{
    const redis=await getPersistRedis(),body=serializeSession();
    if(redis)try{await redis.set(SESSION_REDIS_KEY,body);return;}catch{ /* fall through to file */ }
    const temporary=`${SESSION_FILE}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary,body,{mode:0o600});
      fs.renameSync(temporary,SESSION_FILE);
    }catch(err){console.warn('[SportyBet session] Could not persist session:',err.message);}
  });
  sessionWrite=next.catch(()=>{});
  return next;
}

let loadSessionPromise = null;
async function loadPersistedSession() {
  if (loadSessionPromise) return loadSessionPromise;
  if (session.loaded) return;
  loadSessionPromise = restorePersistedSession();
  try { await loadSessionPromise; session.loaded = true; }
  finally { loadSessionPromise = null; }
}
async function restorePersistedSession() {
  let body = null;
  const redis = await getPersistRedis();
  if (redis) {
    try { body = await redis.get(SESSION_REDIS_KEY); } catch { /* ignore */ }
  }
  if (!body) {
    try { body = fs.readFileSync(SESSION_FILE, 'utf8'); } catch { /* no saved session */ }
  }
  if (!body) {
    bootstrapCookiesFromEnv();
    return;
  }
  try {
    const saved = JSON.parse(body);
    for (const [name, entry] of (saved.cookies || [])) {
      if (entry && entry.value && (!entry.expiresAt || entry.expiresAt > Date.now())) {
        session.cookies.set(name, entry);
      }
    }
    session.token = saved.token || null;
    const savedTokenCookie = (saved.cookies || []).find(([name, entry]) => name === 'accessToken' && entry?.value === saved.token)?.[1];
    session.tokenExpiresAt = saved.tokenExpiresAt || savedTokenCookie?.expiresAt || tokenExpiry(session.token);
    session.tokenHeader = saved.tokenHeader || 'authorization';
    session.bootstrapFingerprint = saved.bootstrapFingerprint || null;
    session.loggedInAt = saved.loggedInAt || null;
    session.lastRefreshAt = saved.lastRefreshAt || saved.loggedInAt || null;
    session.loginMethod = saved.loginMethod || null;
    for (const [kind, path] of Object.entries(saved.resolvedEndpoints || {})) {
      if (ENDPOINT_CANDIDATES[kind] && typeof path === 'string' && path) resolvedEndpoints.set(kind, path);
    }
    if (session.cookies.size || session.token) {
      console.log(`[SportyBet session] Restored persisted session (${session.cookies.size} cookies${session.token ? ' + token' : ''}, saved ${saved.savedAt || 'unknown'})`);
    }
  } catch (err) {
    console.warn('[SportyBet session] Ignoring unreadable persisted session:', err.message);
  }
  bootstrapCookiesFromEnv();
}

// Optional recovery seed. Automatic website-form login normally obtains the
// session without copied cookies. A CHANGED bootstrap
// value replaces stale saved credentials; the same value does not overwrite
// newer rotated credentials on every restart.
function bootstrapCookiesFromEnv() {
  const raw = String(process.env.SPORTYBET_BOOTSTRAP_COOKIES || '').trim();
  if (!raw) return;
  const fingerprint = crypto.createHash('sha256').update(raw).digest('hex');
  if (session.bootstrapFingerprint === fingerprint) return;
  const supplied = raw.split(';').map(part => {
    const idx = part.indexOf('=');
    return idx < 1 ? null : [part.slice(0, idx).trim(), part.slice(idx + 1).trim()];
  }).filter(entry => entry?.[0] && entry[1]);
  if (!supplied.some(([name]) => isAuthCookie(name) || name === 'refreshToken')) return;
  clearAuthentication({ refresh: true });
  let added = 0;
  for (const [name, value] of supplied) {
    session.cookies.set(name, { value, expiresAt: isAuthCookie(name) ? tokenExpiry(value) : null });
    added += 1;
  }
  session.bootstrapFingerprint = fingerprint;
  session.lastRefreshAt = new Date().toISOString();
  session.authGeneration += 1;
  loginFailure = null;
  if (added) {
    console.log(`[SportyBet session] Bootstrapped ${added} cookies from SPORTYBET_BOOTSTRAP_COOKIES`);
  }
}

// Decoding an expiry is only a local expiry hint, never proof of authenticity.
function tokenExpiry(token) {
  try {
    const parts = String(token || '').replace(/^bearer\s+/i, '').split('.');
    if (parts.length !== 3) return null;
    const exp = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).exp;
    return Number.isFinite(Number(exp)) && Number(exp) > 0 ? Number(exp) * 1000 : null;
  } catch { return null; }
}
function isAuthCookie(name) {
  return /^(?:accessToken|authToken|token|session|sessionid|sid|JSESSIONID)$/i.test(name);
}
function clearAuthentication({ refresh = false } = {}) {
  session.token = null;
  session.tokenExpiresAt = null;
  session.lastAuthenticatedAt = null;
  session.loggedInAt = null;
  for (const name of session.cookies.keys()) {
    if (isAuthCookie(name) || (refresh && name === 'refreshToken')) session.cookies.delete(name);
  }
}

// Encrypt the login payload exactly once per login: SportyBet's web login
// fetches a one-time 16-byte key from /patron/cipher and POSTs the whole
// payload as a single AES-128-encrypted base64 blob to /patron/accessToken.
// This legacy cipher adapter has NOT been verified against the current web
// bundle. Do not guess alternative modes/retry passwords to find one that
// works. A browser-issued session is supported independently of this adapter.
function encryptLoginPayload(plaintext, keyB64) {
  const key = Buffer.from(String(keyB64), 'base64');
  if (key.length !== 16) throw sportyError(`SportyBet cipher key has ${key.length} bytes, expected 16`, 'SPORTYBET_AUTH_FAILED');
  const mode = String(process.env.SPORTYBET_LOGIN_CIPHER_MODE || 'cbc').toLowerCase();
  if (mode === 'ecb') {
    const c = crypto.createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([c.update(plaintext, 'utf8'), c.final()]).toString('base64');
  }
  const ivKind = String(process.env.SPORTYBET_LOGIN_IV || 'zero').toLowerCase();
  const iv = ivKind === 'key' ? key : Buffer.alloc(16, 0);
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(plaintext, 'utf8'), c.final()]).toString('base64');
}

function parseSetCookies(res) {
  let raw = [];
  try {
    if (typeof res.headers.getSetCookie === 'function') raw = res.headers.getSetCookie();
    else if (typeof res.headers.raw === 'function') raw = res.headers.raw()['set-cookie'] || [];
    else {
      const single = res.headers.get('set-cookie');
      if (single) raw = single.split(/,(?=\s*[^;,=\s]+\s*=)/);
    }
  } catch { raw = []; }
  const now = Date.now();
  for (const line of raw) {
    const first = String(line).split(';')[0];
    const idx = first.indexOf('=');
    if (idx < 1) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (!name) continue;
    let expiresAt = null;
    const maxAge = String(line).match(/max-age=(-?\d+)/i);
    const expires = String(line).match(/expires=([^;]+)/i);
    if (maxAge) expiresAt = now + Number(maxAge[1]) * 1000;
    else if (expires) {
      const t = Date.parse(expires[1]);
      if (Number.isFinite(t)) expiresAt = t;
    }
    const previous = session.cookies.get(name);
    if (!value || (expiresAt !== null && expiresAt <= now)) {
      session.cookies.delete(name);
      if (name === 'accessToken' || (isAuthCookie(name) && session.token === previous?.value)) {
        session.token = null; session.tokenExpiresAt = null; session.lastAuthenticatedAt = null;
      }
    } else {
      session.cookies.set(name, { value, expiresAt });
      if (name === 'accessToken' && previous?.value !== value) {
        session.token = null; session.tokenExpiresAt = null; session.lastAuthenticatedAt = null;
        session.authGeneration += 1;
      }
    }
  }
}

// SportyBet's patron endpoints expect a deviceId cookie on every call (the
// browser gets one early and keeps it for a year). Generate one per server
// and persist it with the session so it stays stable across restarts.
function ensureDeviceId() {
  for(const name of ['device-id','deviceId']) {
    const existing=session.cookies.get(name);
    if(existing?.value)return existing.value;
  }
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const id = `${stamp}bdid${crypto.randomInt(10000000, 99999999)}`;
  session.cookies.set('deviceId', { value: id, expiresAt: Date.now() + 365 * 24 * 3600 * 1000 });
  return id;
}

function cookieHeader() {
  const now = Date.now();
  const parts = [];
  for (const [name, entry] of session.cookies) {
    const expiry = entry.expiresAt || (isAuthCookie(name) ? tokenExpiry(entry.value) : null);
    if (expiry && expiry <= now) { session.cookies.delete(name); continue; }
    parts.push(`${name}=${entry.value}`);
  }
  return parts.join('; ');
}

function extractToken(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.token, payload.accessToken, payload.access_token, payload.jwt,
    payload.data && (payload.data.token || payload.data.accessToken || payload.data.access_token || payload.data.jwt),
    payload.data && payload.data.user && (payload.data.user.token || payload.data.user.accessToken),
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 8) return c;
  }
  return null;
}

function responseDetail(payload) {
  let detail = String(payload?.message || payload?.innerMsg || payload?.error || payload?.msg || 'SportyBet rejected the request');
  for (const value of [process.env.SPORTYBET_PASSWORD, process.env.SPORTYBET_PHONE]) {
    if (value) detail = detail.split(value).join('[redacted]');
  }
  return detail.slice(0, 240);
}
function failedPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.bizCode !== undefined && Number(payload.bizCode) !== 10000) return true;
  return !!(payload.status && !/^(success|ok|200)$/i.test(String(payload.status)) && (payload.error || payload.message));
}
function authFailurePayload(payload, endpoint) {
  if (!failedPayload(payload)) return false;
  if (Number(payload.bizCode) === 19001) return false;
  if (endpoint === ENDPOINTS.userInfo || /\/patron\/(?:account|user)\/info$/.test(endpoint)) return true;
  return /(?:token|session).*(?:expir|invalid|missing)|(?:expir|invalid).*token|(?:not|need|must|please|require).*log.?in|log.?in.*(?:expir|require|again)|unauthori[sz]ed|not authenticated|authentication.*(?:fail|require)/i.test(responseDetail(payload));
}

// ---------------------------------------------------------------------------
// Core request wrapper
// ---------------------------------------------------------------------------

const inFlightGet = new Map();

async function sportyRequest(endpoint, {
  method = 'GET',
  params = {},
  body,
  auth = false,
  timeoutMs = REQUEST_TIMEOUT_MS,
  retryAuth = true,
  extraHeaders = {},
} = {}) {
  const url = new URL(`${BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const upperMethod = String(method).toUpperCase();

  // Collapse identical concurrent GETs into one upstream request.
  const dedupeKey = upperMethod === 'GET' ? `${auth ? 'auth' : 'public'}:${url}` : null;
  if (dedupeKey && inFlightGet.has(dedupeKey)) return inFlightGet.get(dedupeKey);

  const send = async (canRetry) => {
    await loadPersistedSession();
    ensureDeviceId(); // patron endpoints expect a deviceId cookie
    const requestGeneration = session.authGeneration;

    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': SITE_ORIGIN,
      'Referer': `${SITE_ORIGIN}/ng/`,
      // Sent by the site's own web app on every API call.
      'clientid': String(process.env.SPORTYBET_CLIENT_ID || 'web'),
      'operid': String(process.env.SPORTYBET_OPER_ID || '2'),
      'platform': String(process.env.SPORTYBET_PLATFORM || 'web'),
      ...extraHeaders,
    };
    const cookies = cookieHeader();
    if (cookies) headers['Cookie'] = cookies;
    const bearerExpiry = session.tokenExpiresAt || tokenExpiry(session.token);
    if (session.token && (!bearerExpiry || bearerExpiry > Date.now())) {
      headers[session.tokenHeader] = /^bearer\s/i.test(session.token) ? session.token : `Bearer ${session.token}`;
      // Some SportyBet routes read the raw token header instead of Authorization.
      headers['token'] = session.token.replace(/^bearer\s+/i, '');
    }

    const options = { method: upperMethod, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || REQUEST_TIMEOUT_MS));
    options.signal = controller.signal;

    let res;
    let text;
    try {
      res = await rawFetch(url.toString(), options);
      text = await res.text();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw sportyError(`SportyBet ${endpoint} timed out after ${Math.max(1000, Number(timeoutMs) || REQUEST_TIMEOUT_MS)}ms`, 'SPORTYBET_TIMEOUT');
      }
      throw sportyError(`SportyBet ${endpoint} network error: ${err.message}`, 'SPORTYBET_NETWORK', { cause: err });
    } finally {
      clearTimeout(timer);
    }

    parseSetCookies(res);

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html') || /^\s*<!doctype html|^\s*<html/i.test(text)) {
      throw classifyHtmlBlock(url.toString(), text);
    }

    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch {
      if (res.ok) throw sportyError(`SportyBet ${endpoint} returned invalid JSON`, 'SPORTYBET_NON_JSON');
      payload = {};
    }
    const rejectedAuth = auth && (res.status === 401 || res.status === 403 || authFailurePayload(payload, endpoint));
    if (rejectedAuth) {
      if (canRetry) {
        console.warn(`[SportyBet session] ${endpoint} rejected the session; trying refresh before login`);
        await recoverAuthentication(requestGeneration);
        // Retry inside the existing promise. Re-entering sportyRequest would
        // await this same in-flight GET and never resolve.
        return send(false);
      }
      if (session.authGeneration === requestGeneration) {
        clearAuthentication();
        await persistSession();
      }
      throw sportyError(`SportyBet dummy session rejected: ${responseDetail(payload)}. Automatic recovery could not complete this request; check session diagnostics.`,
        'SPORTYBET_AUTH_FAILED', { status: res.status, bizCode: payload?.bizCode });
    }

    if (!res.ok) {
      const err = sportyError(`SportyBet ${endpoint} -> ${res.status}: ${String(text).slice(0, 300)}`, 'SPORTYBET_HTTP', { status: res.status });
      throw err;
    }

    if (Number(payload?.bizCode) === 19001) {
      throw sportyError(`SportyBet ${endpoint}: resource not found`, 'SPORTYBET_HTTP', { status: 404 });
    }
    if (failedPayload(payload)) {
      throw sportyError(`SportyBet ${endpoint} rejected the request${payload.bizCode !== undefined ? ` (bizCode ${payload.bizCode})` : ''}: ${responseDetail(payload)}`,
        'SPORTYBET_API', { bizCode: payload.bizCode });
    }
    return payload;
  };
  const run = send(auth && retryAuth);

  if (!dedupeKey) return run;
  inFlightGet.set(dedupeKey, run);
  try {
    return await run;
  } finally {
    if (inFlightGet.get(dedupeKey) === run) inFlightGet.delete(dedupeKey);
  }
}

// ---------------------------------------------------------------------------
// Endpoint resolution: SportyBet has renamed its factsCenter routes before
// (e.g. prematchSportEvents -> pcUpcomingEvents). For the public data routes
// we keep a candidate list and probe in order; the first path that answers
// with anything other than the gateway's 404 "Resource not found" wins and is
// remembered (memory + persisted session). A later 404 on the remembered path
// drops it and re-probes, so route renames self-heal without a deploy.
// ---------------------------------------------------------------------------

function isWrongPathError(err) {
  return Number(err && err.status) === 404 || (err && err.code === 'SPORTYBET_NON_JSON');
}

// When every candidate fails, remember that briefly so call loops (e.g. the
// per-event detail fallback) fail fast instead of re-probing every path for
// every event.
const failedResolutionUntil = new Map(); // kind -> timestamp ms
const RESOLUTION_FAILURE_TTL_MS = Math.max(60000, parseInt(process.env.SPORTYBET_RESOLUTION_RETRY_MS || '600000', 10) || 600000);

async function requestWithResolution(kind, { params, method = 'GET', body, auth = false, timeoutMs, extraHeaders } = {}) {
  await loadPersistedSession(); // seeds resolvedEndpoints from the persisted session
  const failedUntil = failedResolutionUntil.get(kind) || 0;
  if (!resolvedEndpoints.has(kind) && failedUntil > Date.now()) {
    throw sportyError(
      `SportyBet ${kind}: no known endpoint path answered recently; next probe at ${new Date(failedUntil).toISOString()}. Set the matching SPORTYBET_ENDPOINT_* variable to skip probing.`,
      'SPORTYBET_ENDPOINT_UNKNOWN'
    );
  }
  const candidates = candidatesFor(kind);
  const preferred = resolvedEndpoints.get(kind);
  const ordered = preferred && candidates.includes(preferred)
    ? [preferred, ...candidates.filter(c => c !== preferred)]
    : candidates;
  const tried = [];
  let lastErr = null;
  for (const path of ordered) {
    tried.push(path);
    try {
      const payload = await sportyRequest(path, { method, params, body, auth, timeoutMs, extraHeaders });
      if (resolvedEndpoints.get(kind) !== path) {
        resolvedEndpoints.set(kind, path);
        failedResolutionUntil.delete(kind);
        persistSession().catch(() => {});
        console.log(`[SportyBet] ${kind} endpoint resolved to ${path}`);
      }
      return payload;
    } catch (err) {
      lastErr = err;
      if (isWrongPathError(err)) {
        if (resolvedEndpoints.get(kind) === path) resolvedEndpoints.delete(kind);
        console.warn(`[SportyBet] ${kind} candidate ${path} not usable (${err.status || err.code}); trying next candidate`);
        continue;
      }
      throw err; // geo-block / bot challenge / timeout: more paths will not help
    }
  }
  failedResolutionUntil.set(kind, Date.now() + RESOLUTION_FAILURE_TTL_MS);
  throw sportyError(
    `SportyBet ${kind}: none of the known endpoint paths answered (tried: ${tried.join(', ')}). Last error: ${lastErr ? lastErr.message : 'n/a'}. Capture the current path from a browser in Nigeria (DevTools > Network) and set the matching SPORTYBET_ENDPOINT_* variable.`,
    'SPORTYBET_ENDPOINT_UNKNOWN',
    { tried }
  );
}

// ---------------------------------------------------------------------------
// Login + keep-alive
// ---------------------------------------------------------------------------

function credentialsConfigured() {
  return !!(process.env.SPORTYBET_PHONE && process.env.SPORTYBET_PASSWORD);
}

let loginPromise = null;
let loginFailure = null;

async function login({ force = false, bypassBackoff = false } = {}) {
  if (loginPromise) return loginPromise;
  if (!bypassBackoff && loginFailure?.until > Date.now()) {
    throw sportyError(`${loginFailure.error.message} Next automatic login retry: ${new Date(loginFailure.until).toISOString()}.`,
      loginFailure.error.code, { bizCode: loginFailure.error.bizCode, retryAt: new Date(loginFailure.until).toISOString(),
        requiresUserAction:loginFailure.error.requiresUserAction,reason:loginFailure.error.reason });
  }
  if (!credentialsConfigured()) {
    if (process.env.SPORTYBET_BOOTSTRAP_COOKIES || usableCookie('refreshToken')) {
      const error = sportyError('SportyBet could not renew the dummy browser session. Set SPORTYBET_PHONE and SPORTYBET_PASSWORD on the server to enable automatic sign-in.', 'SPORTYBET_AUTH_FAILED', {requiresUserAction:true,reason:'credentials_required'});
      loginFailure = { error, until: Date.now() + LOGIN_RETRY_MS };
      session.lastLoginError = error.message;
      session.requiresUserAction=true;
      throw error;
    }
    throw sportyError(
      'SportyBet dummy account is not configured. Set SPORTYBET_PHONE and SPORTYBET_PASSWORD on the server.',
      'SPORTYBET_NOT_CONFIGURED'
    );
  }

  loginPromise = (async () => {
    await loadPersistedSession();

    if (!force && hasAuthenticatedSession() && session.loggedInAt) {
      return { reused: true };
    }

    if(LOGIN_METHOD==='browser') {
      clearAuthentication({refresh:true});
      const run=browserLoginImpl||require('./sportyBrowserLogin').browserLogin;
      const result=await run({siteOrigin:SITE_ORIGIN,baseUrl:BASE_URL,userInfo:ENDPOINTS.userInfo,
        phone:process.env.SPORTYBET_PHONE,password:process.env.SPORTYBET_PASSWORD,
        cookies:[...session.cookies].map(([name,entry])=>({name,...entry}))});
      for(const cookie of result.cookies||[])if(cookie.name&&cookie.value&&(!cookie.expiresAt||cookie.expiresAt>Date.now())) {
        session.cookies.set(cookie.name,{value:cookie.value,expiresAt:cookie.expiresAt||null});
      }
      if(!hasAuthenticatedSession())throw sportyError('Browser sign-in returned no authenticated SportyBet session.','SPORTYBET_AUTH_FAILED');
      session.lastAuthenticatedAt=Number(result.verifiedAt)||0;
      session.loggedInAt=session.lastRefreshAt=new Date().toISOString();
      session.lastRefreshError=session.lastLoginError=null;
      session.requiresUserAction=false;
      session.loginMethod='browser';session.authGeneration+=1;session.loginCount+=1;
      await persistSession();
      console.log('[SportyBet session] Dummy account signed in through the browser; session saved automatically');
      return {reused:false,method:'browser',cookies:session.cookies.size};
    }
    if(LOGIN_METHOD!=='api')throw sportyError('SPORTYBET_LOGIN_METHOD must be browser or api.','SPORTYBET_AUTH_FAILED',{requiresUserAction:true});

    let extra = {};
    if (process.env.SPORTYBET_LOGIN_EXTRA) {
      try { extra = JSON.parse(process.env.SPORTYBET_LOGIN_EXTRA); }
      catch { console.warn('[SportyBet session] SPORTYBET_LOGIN_EXTRA is not valid JSON; ignoring'); }
    }
    const body = {
      phone: String(process.env.SPORTYBET_PHONE),
      password: String(process.env.SPORTYBET_PASSWORD),
      deviceId: String(process.env.SPORTYBET_DEVICE_ID || 'web'),
      ...extra,
    };

    // Login must not reuse stale cookies: SportyBet can reject a login that
    // arrives attached to a dead session. The deviceId cookie is NOT a
    // session cookie — it identifies the "device" and must stay (and be sent
    // with the login itself, like the browser does).
    clearAuthentication({ refresh: true });
    ensureDeviceId();

    // Login path self-heal: SportyBet moved its account service before (the
    // site's account-info call now lives under /api/ng/patron/...), so probe
    // the candidate list once per login and adopt the first path that answers
    // with anything other than the gateway's 404 "Resource not found". The
    // resolved path is persisted with the session; geo/bot blocks abort
    // probing immediately — more paths will not help.
    const loginFailedUntil = failedResolutionUntil.get('login') || 0;
    if (!resolvedEndpoints.has('login') && loginFailedUntil > Date.now()) {
      throw sportyError(
        `SportyBet login: no known login path answered recently; next probe at ${new Date(loginFailedUntil).toISOString()}. Set SPORTYBET_ENDPOINT_LOGIN to skip probing.`,
        'SPORTYBET_ENDPOINT_UNKNOWN'
      );
    }
    const loginCandidates = candidatesFor('login');
    const preferredLogin = resolvedEndpoints.get('login');
    const orderedLogin = preferredLogin && preferredLogin !== '/users/login' && !process.env.SPORTYBET_ENDPOINT_LOGIN && loginCandidates.includes(preferredLogin)
      ? [preferredLogin, ...loginCandidates.filter(c => c !== preferredLogin)]
      : loginCandidates;

    let res = null;
    let text = '';
    let usedLoginPath = null;
    const triedLoginPaths = [];
    for (const candidatePath of orderedLogin) {
      triedLoginPaths.push(candidatePath);
      // The patron login encrypts the WHOLE body: fetch a one-time AES-128
      // key from /patron/cipher (empty POST), then POST the encrypted blob.
      // Other candidates keep the plain JSON body.
      let requestBody = JSON.stringify(body);
      if (/\/accessToken$/.test(candidatePath)) {
        let cipherPayload = null;
        try {
          cipherPayload = await sportyRequest(ENDPOINTS.cipher, { method: 'POST', timeoutMs: REQUEST_TIMEOUT_MS, retryAuth: false });
        } catch (cipherErr) {
          if (isWrongPathError(cipherErr)) {
            console.warn(`[SportyBet] cipher endpoint ${ENDPOINTS.cipher} not usable (${cipherErr.status || cipherErr.code}); cannot use ${candidatePath} this round`);
            continue;
          }
          throw cipherErr;
        }
        const keyB64 = cipherPayload && cipherPayload.data && cipherPayload.data.password;
        const ursId = cipherPayload && cipherPayload.data && cipherPayload.data.ursId;
        if (!keyB64) {
          session.lastLoginError = 'cipher endpoint returned no encryption key';
          throw sportyError('SportyBet cipher endpoint returned no encryption key', 'SPORTYBET_AUTH_FAILED');
        }
        requestBody = encryptLoginPayload(JSON.stringify({
          phone: body.phone,
          password: body.password,
          ...(ursId ? { ursId } : {}),
          ...extra,
        }), keyB64);
      }
      const url = `${BASE_URL}${candidatePath.startsWith('/') ? candidatePath : `/${candidatePath}`}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        res = await rawFetch(url, {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Origin': SITE_ORIGIN,
            'Referer': `${SITE_ORIGIN}/ng/`,
            // Observed on the site's own login request; overridable if
            // SportyBet ever changes them.
            'clientid': String(process.env.SPORTYBET_CLIENT_ID || 'web'),
            'operid': String(process.env.SPORTYBET_OPER_ID || '2'),
            'platform': String(process.env.SPORTYBET_PLATFORM || 'web'),
            'Cookie': cookieHeader(),
          },
          body: requestBody,
          signal: controller.signal,
        });
        text = await res.text();
      } catch (err) {
        const code = err && err.name === 'AbortError' ? 'SPORTYBET_TIMEOUT' : 'SPORTYBET_NETWORK';
        session.lastLoginError = err.message;
        throw sportyError(`SportyBet login failed: ${err.message}`, code);
      } finally {
        clearTimeout(timer);
      }

      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html') || /^\s*<!doctype html|^\s*<html/i.test(text);
      // The gateway answers unknown routes with a 404 (JSON bizCode 19001 or a
      // plain 404 page) — either way that candidate is wrong; try the next.
      let probePayload = null;
      if (!isHtml) { try { probePayload = text ? JSON.parse(text) : null; } catch { probePayload = null; } }
      const wrongPath = res.status === 404 || (probePayload && Number(probePayload.bizCode) === 19001);
      if (wrongPath) {
        if (resolvedEndpoints.get('login') === candidatePath) resolvedEndpoints.delete('login');
        console.warn(`[SportyBet] login candidate ${candidatePath} not usable (404); trying next candidate`);
        continue;
      }
      if (isHtml) throw classifyHtmlBlock(url, text);
      usedLoginPath = candidatePath;
      break;
    }

    if (!usedLoginPath) {
      failedResolutionUntil.set('login', Date.now() + RESOLUTION_FAILURE_TTL_MS);
      session.lastLoginError = `no known login path answered (all 404; tried: ${triedLoginPaths.join(', ')})`;
      throw sportyError(
        `SportyBet login: none of the known login paths answered (tried: ${triedLoginPaths.join(', ')}). Capture the current login request from a Nigerian browser (DevTools > Network while logging in) and set SPORTYBET_ENDPOINT_LOGIN to its path.`,
        'SPORTYBET_ENDPOINT_UNKNOWN',
        { tried: triedLoginPaths }
      );
    }
    if (resolvedEndpoints.get('login') !== usedLoginPath) {
      resolvedEndpoints.set('login', usedLoginPath);
      failedResolutionUntil.delete('login');
      console.log(`[SportyBet] login endpoint resolved to ${usedLoginPath}`);
    }

    parseSetCookies(res);

    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }

    if (!res.ok) {
      const detail = responseDetail(payload);
      session.lastLoginError = `${res.status} ${detail}`;
      // Surface OTP requirements clearly: auto-renewal cannot pass an SMS challenge.
      const otp = /otp|verification code|one[- ]time/i.test(String(detail));
      throw sportyError(
        `SportyBet login rejected (${res.status}): ${detail}${otp ? ' — this account appears to require OTP; automatic session renewal is not possible while OTP is enabled.' : ''}`,
        'SPORTYBET_AUTH_FAILED',
        { status: res.status }
      );
    }

    const token = extractToken(payload);
    if (failedPayload(payload)) {
      const detail = responseDetail(payload);
      session.lastLoginError = detail;
      throw sportyError(`SportyBet rejected the dummy-account login${payload.bizCode !== undefined ? ` (bizCode ${payload.bizCode})` : ''}: ${detail}. Use a fresh dummy browser session in SPORTYBET_BOOTSTRAP_COOKIES; an HTTP 200 response is not a successful login.`,
        'SPORTYBET_AUTH_FAILED', { bizCode: payload.bizCode });
    }
    if (!token && !hasAuthenticatedSession()) {
      const serverMsg = responseDetail(payload);
      session.lastLoginError = `no token or session cookie in login response${serverMsg ? ` (${serverMsg})` : ''}`;
      throw sportyError(
        `SportyBet login returned no authenticated token or cookie${serverMsg ? ` — server said: ${serverMsg}` : ''}. Use a fresh dummy browser session in SPORTYBET_BOOTSTRAP_COOKIES.`,
        'SPORTYBET_AUTH_FAILED'
      );
    }

    session.token = token;
    const tokenCookie = session.cookies.get('accessToken');
    session.tokenExpiresAt = tokenExpiry(token) || (tokenCookie?.value === token ? tokenCookie.expiresAt : null);
    session.loggedInAt = new Date().toISOString();
    session.lastRefreshAt = session.loggedInAt;
    session.lastRefreshError = null;
    session.requiresUserAction = false;
    session.loginMethod = 'api';
    session.authGeneration += 1;
    session.lastLoginError = null;
    session.loginCount += 1;
    await persistSession();
    console.log(`[SportyBet session] Logged in dummy account (${session.cookies.size} cookies${token ? ' + token' : ''}) — login #${session.loginCount}`);
    return { reused: false, token: !!token, cookies: session.cookies.size };
  })();

  try {
    const result = await loginPromise;
    loginFailure = null;
    return result;
  } catch (err) {
    clearAuthentication({ refresh: true });
    session.lastLoginError = err.message;
    session.requiresUserAction=Boolean(err.requiresUserAction);
    loginFailure = { error: err, until: Date.now() + Math.max(LOGIN_RETRY_MS,err.requiresUserAction?900000:0) };
    err.retryAt=new Date(loginFailure.until).toISOString();
    await persistSession();
    throw err;
  } finally {
    loginPromise = null;
  }
}

let ensurePromise = null;
async function ensureSession({ validate = false } = {}) {
  // Session loading, expiry recovery and verification are shared across the
  // whole market fan-out. Validation is bounded to one account check/minute.
  while (ensurePromise) {
    await ensurePromise;
    if (!validate || session.lastAuthenticatedAt > Date.now() - SESSION_CHECK_MS) return;
  }
  ensurePromise = (async () => {
    await loadPersistedSession();
    if(hasAuthenticatedSession()&&refreshDue()&&usableCookie('refreshToken'))await refreshSession();
    if (!hasAuthenticatedSession()) {
      if (loginFailure?.until > Date.now()) await login(); // fail fast during the shared backoff
      if (!(usableCookie('refreshToken') && await refreshSession())) await login();
    }
    if (!hasAuthenticatedSession()) throw sportyError('SportyBet dummy session is not authenticated.', 'SPORTYBET_AUTH_FAILED');
    if (validate && (!session.lastAuthenticatedAt || session.lastAuthenticatedAt <= Date.now() - SESSION_CHECK_MS)) {
      await requestWithResolution('userInfo', { auth: true, timeoutMs: 10000 });
      session.lastAuthenticatedAt = Date.now();
      await persistSession();
    }
  })();
  const pending = ensurePromise;
  try { await pending; }
  finally { if (ensurePromise === pending) ensurePromise = null; }
}

function usableCookie(name) {
  const cookie = session.cookies.get(name);
  return !!(cookie?.value && (!cookie.expiresAt || cookie.expiresAt > Date.now()));
}
function hasAuthenticatedSession() {
  // deviceId and analytics cookies belong to anonymous visitors too.
  const expiry = session.tokenExpiresAt || tokenExpiry(session.token);
  return !!(session.token && (!expiry || expiry > Date.now())) || [...session.cookies.keys()].some(name=>
    isAuthCookie(name) && usableCookie(name) && (!tokenExpiry(session.cookies.get(name).value) || tokenExpiry(session.cookies.get(name).value) > Date.now()));
}
function sessionRequired() {
  return credentialsConfigured() || !!process.env.SPORTYBET_BOOTSTRAP_COOKIES || hasAuthenticatedSession() || usableCookie('refreshToken');
}

function refreshDue(now=Date.now()) {
  if(refreshFailureUntil>now)return false;
  const expiries=[session.tokenExpiresAt||tokenExpiry(session.token),
    session.cookies.get('accessToken')?.expiresAt||tokenExpiry(session.cookies.get('accessToken')?.value)].filter(Number.isFinite).filter(v=>v>0);
  const last=Date.parse(session.lastRefreshAt||session.loggedInAt||'');
  return expiries.some(expiry=>expiry<=now+REFRESH_MARGIN_SECONDS*1000)||!Number.isFinite(last)||now-last>=REFRESH_SECONDS*1000;
}

let recoveryPromise = null;
async function recoverAuthentication(requestGeneration) {
  if (hasAuthenticatedSession() && session.authGeneration > requestGeneration) return;
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    clearAuthentication();
    await persistSession();
    if (usableCookie('refreshToken') && await refreshSession()) return;
    await login({ force: true });
  })();
  try { await recoveryPromise; }
  finally { recoveryPromise = null; }
}

// Keep-alive: ping a light authenticated endpoint before cookies die, persist
// whatever set-cookie comes back, and re-login immediately when the session is
// already gone. Renewal can still fail when SportyBet rejects the refresh
// cookie or requests account verification.
// Try a refresh cookie before password login. Server-side invalidation, OTP,
// region restrictions and service errors can still require manual recovery.
let refreshPromise = null;
let refreshFailureUntil=0;
async function refreshSession() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    await loadPersistedSession();
    if (!usableCookie('refreshToken')) return false;
    const before = session.cookies.get('accessToken');
    try {
      const payload = await sportyRequest(ENDPOINTS.refresh, { method: 'POST', auth: true, timeoutMs: 10000, retryAuth: false });
      const ok = payload && (Number(payload.bizCode) === 10000 || String(payload.status || '').toLowerCase() === 'success');
      if (!ok)throw new Error('SportyBet did not accept token refresh');
      const after = session.cookies.get('accessToken');
      const issuedCookie = usableCookie('accessToken') && (after?.value !== before?.value || after?.expiresAt !== before?.expiresAt);
      const token = extractToken(payload) || (issuedCookie ? after.value : null);
      if (!token)throw new Error('SportyBet refresh returned no usable access token');
      session.token = token;
      session.tokenExpiresAt = tokenExpiry(token) || (after?.value === token ? after.expiresAt : null);
      if (!after || after.value !== token) {
        session.cookies.set('accessToken', {value:token, expiresAt:tokenExpiry(token)});
      }
      const rotatedRefresh=payload?.data?.refreshToken||payload?.data?.refresh_token||payload?.refreshToken||payload?.refresh_token;
      if(typeof rotatedRefresh==='string'&&rotatedRefresh)session.cookies.set('refreshToken',{value:rotatedRefresh,expiresAt:tokenExpiry(rotatedRefresh)});
      if (!hasAuthenticatedSession()) { clearAuthentication(); return false; }
      session.loggedInAt = new Date().toISOString();
      session.lastRefreshAt=session.loggedInAt;
      session.lastRefreshError=session.lastLoginError=null;session.requiresUserAction=false;refreshFailureUntil=0;
      session.authGeneration += 1;
      loginFailure = null;
      await persistSession();
      console.log('[SportyBet session] Access token rotated via patron/refresh');
      return true;
    } catch (err) {
      session.lastRefreshError=err.message;
      refreshFailureUntil=Date.now()+LOGIN_RETRY_MS;
      console.warn(`[SportyBet session] patron/refresh failed: ${err.message}`);
      return false;
    }
  })();
  try { return await refreshPromise; }
  finally { refreshPromise = null; }
}

let keepAliveTimer = null;
let keepAlivePromise=null;
async function maintainSession() {
  if(keepAlivePromise)return keepAlivePromise;
  keepAlivePromise=(async()=>{
    try {
      // ensureSession handles proactive refresh, expiry, one shared recovery
      // and browser re-login. Do not duplicate failed logins in this timer.
      await ensureSession({validate:true});
      session.lastKeepAliveOk=true;
    }catch(err){
      session.lastKeepAliveOk=false;
      console.warn(`[SportyBet session] Automatic maintenance stopped (${err.code||'unknown'}): ${err.message}`);
    }finally{
      session.lastKeepAliveAt=new Date().toISOString();
      await persistSession();
    }
  })();
  try{await keepAlivePromise;}finally{keepAlivePromise=null;}
}
function startKeepAlive() {
  if (keepAliveTimer || (!credentialsConfigured() && !process.env.SPORTYBET_BOOTSTRAP_COOKIES)) return;
  const tick=()=>{void maintainSession().catch(err=>console.warn('SportyBet session persistence failed:',err.message));};
  keepAliveTimer = setInterval(tick, KEEPALIVE_SECONDS * 1000);
  if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref(); // never keep one-off jobs alive
  // Prime the session shortly after boot instead of waiting a full interval.
  setTimeout(tick, 3000).unref?.();
  console.log(`[SportyBet session] Keep-alive enabled every ${KEEPALIVE_SECONDS}s`);
}

function sessionStatus() {
  const now = Date.now();
  const cookies = [...session.cookies.entries()].map(([name, entry]) => ({
    name,
    expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
    expiresInMinutes: entry.expiresAt ? Math.round((entry.expiresAt - now) / 60000) : null,
  }));
  return {
    configured: credentialsConfigured(),
    baseUrl: BASE_URL,
    proxyConfigured: !!PROXY_URL,
    proxyActive: !!getDispatcher(),
    endpoints: { ...ENDPOINTS },
    resolvedEndpoints: Object.fromEntries(resolvedEndpoints),
    endpointCandidates: Object.fromEntries(Object.entries(ENDPOINT_CANDIDATES).map(([k, v]) => [k, candidatesFor(k)])),
    params: { sport: PARAM_SPORT, market: PARAM_MARKET, page: PARAM_PAGE, pageSize: PARAM_PAGE_SIZE, eventId: PARAM_EVENT_ID, cacheBuster: CACHE_BUSTER },
    keepAliveSeconds: KEEPALIVE_SECONDS,
    keepAliveRunning: !!keepAliveTimer,
    loggedIn: hasAuthenticatedSession(),
    hasToken: !!session.token,
    cookies,
    loggedInAt: session.loggedInAt,
    loginCount: session.loginCount,
    lastKeepAliveAt: session.lastKeepAliveAt,
    lastKeepAliveOk: session.lastKeepAliveOk,
    lastLoginError: session.lastLoginError,
    lastAuthenticatedAt: session.lastAuthenticatedAt ? new Date(session.lastAuthenticatedAt).toISOString() : null,
    nextLoginRetryAt: loginFailure?.until > now ? new Date(loginFailure.until).toISOString() : null,
    browserSessionConfigured: !!process.env.SPORTYBET_BOOTSTRAP_COOKIES,
    automaticLoginMethod:LOGIN_METHOD,
    automaticReloginConfigured:credentialsConfigured(),
    lastLoginMethod:session.loginMethod,
    lastRefreshAt:session.lastRefreshAt,
    lastRefreshError:session.lastRefreshError,
    refreshIntervalSeconds:REFRESH_SECONDS,
    requiresUserAction:session.requiresUserAction,
  };
}

// ---------------------------------------------------------------------------
// Public data + booking operations
// ---------------------------------------------------------------------------

function listParams(sportId, page, pageSize, marketIds) {
  const params = {};
  if (PARAM_SPORT) params[PARAM_SPORT] = sportId;
  if (PARAM_MARKET && marketIds) params[PARAM_MARKET] = marketIds;
  if (PARAM_PAGE) params[PARAM_PAGE] = page;
  if (PARAM_PAGE_SIZE) params[PARAM_PAGE_SIZE] = pageSize;
  if (CACHE_BUSTER || currentSportyRequest()) params._t = Date.now();
  return params;
}

async function fetchPrematchPage(sportId, page, pageSize, { marketIds } = {}) {
  await loadPersistedSession();
  const useSession=sessionRequired();
  if(useSession)await ensureSession({validate:true});
  return requestWithResolution('prematch', {
    params: listParams(sportId, page, pageSize, marketIds),
    auth: useSession,
  });
}

// The live/in-play board. When the dummy account is configured the session is
// attached (some live content is served at a higher trust level to logged-in
// users); without credentials the anonymous board is used.
async function fetchLivePage(sportId, page, pageSize, { marketIds } = {}) {
  await loadPersistedSession();
  const useSession = sessionRequired();
  if (useSession) {
    await ensureSession({validate:true});
  }
  return requestWithResolution('live', {
    params: listParams(sportId, page, pageSize, marketIds),
    auth: useSession,
  });
}

async function fetchEventDetail(eventId) {
  // The site loads full market lists for one match through a dedicated detail
  // call (observed as a POST "Outcomes" request). GET with ?eventId= is the
  // default; set SPORTYBET_ENDPOINT_EVENT_METHOD=POST if the capture shows POST.
  await loadPersistedSession();
  const useSession=sessionRequired();
  if(useSession)await ensureSession({validate:true});
  const method = String(process.env.SPORTYBET_ENDPOINT_EVENT_METHOD || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  return requestWithResolution('eventDetail', {
    method,
    params: method === 'GET' ? { [PARAM_EVENT_ID || 'eventId']: eventId, ...(currentSportyRequest()?{_t:Date.now()}:{}) } : {},
    body: method === 'POST' ? { [PARAM_EVENT_ID || 'eventId']: eventId } : undefined,
    auth: useSession,
  });
}

async function lookupBooking(shareCode, { fresh = false } = {}) {
  await loadPersistedSession();
  if (sessionRequired()) await ensureSession({validate:true});
  const params = { shareCode };
  if (fresh) params._ts = Date.now();
  // Booking-code lookup is public on SportyBet; attach the session when we have
  // one anyway so the request benefits from the same trust level as the site.
  const hasSession = hasAuthenticatedSession();
  return sportyRequest(ENDPOINTS.bookingLookup, { params, auth: hasSession });
}

async function createBookingCode(selections) {
  await ensureSession({validate:true});
  const payload = await sportyRequest(ENDPOINTS.bookBet, {
    method: 'POST',
    body: { selections },
    auth: true,
    timeoutMs: Math.max(5000, parseInt(process.env.SPORTYBET_BOOKING_TIMEOUT_MS || '15000', 10) || 15000),
  });
  return payload;
}

module.exports = {
  sportyRequest,
  requestWithResolution,
  fetchPrematchPage,
  fetchLivePage,
  fetchEventDetail,
  lookupBooking,
  createBookingCode,
  login,
  ensureSession,
  hasAuthenticatedSession,
  sessionRequired,
  refreshSession,
  refreshDue,
  maintainSession,
  startKeepAlive,
  sessionStatus,
  credentialsConfigured,
  setFetchForTesting,
  setBrowserLoginForTesting,
  ENDPOINT_CANDIDATES,
  _session: session,
  _resolvedEndpoints: resolvedEndpoints,
};
