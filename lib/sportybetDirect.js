// Direct SportyBet Nigeria web client with a persistent dummy-account session.
//
// This module replaces the old Parse.bot middleman entirely:
//  - Fixtures, markets and odds are read from SportyBet's own public web JSON
//    endpoints. No login is required for reading data.
//  - Creating booking codes requires a logged-in session. The dummy account
//    (SPORTYBET_PHONE / SPORTYBET_PASSWORD) is logged in automatically, its
//    cookies + token are persisted (Redis when REDIS_URL is set, otherwise a
//    local session file), and a keep-alive loop renews the session before it
//    dies. If SportyBet still invalidates the session server-side, the client
//    detects it and logs in again silently.
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
  live: String(process.env.SPORTYBET_ENDPOINT_LIVE || '/factsCenter/pcLiveEvents'),
  bookingLookup: String(process.env.SPORTYBET_ENDPOINT_BOOKING_LOOKUP || '/orders/share'),
  // Session / authenticated
  login: String(process.env.SPORTYBET_ENDPOINT_LOGIN || '/users/login'),
  userInfo: String(process.env.SPORTYBET_ENDPOINT_USERINFO || '/users/info'),
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
    ENDPOINTS.live,
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

const KEEPALIVE_SECONDS = Math.max(60, parseInt(process.env.SPORTYBET_KEEPALIVE_SECONDS || '240', 10) || 240);
const SESSION_FILE = String(process.env.SPORTYBET_SESSION_FILE || path.join(process.cwd(), '.sportybet-session.json'));
const SESSION_REDIS_KEY = String(process.env.SPORTYBET_SESSION_REDIS_KEY || 'sportybet:session:v1');
const REQUEST_TIMEOUT_MS = Math.max(5000, parseInt(process.env.SPORTYBET_REQUEST_TIMEOUT_MS || '20000', 10) || 20000);
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
  loggedInAt: null,
  lastKeepAliveAt: null,
  lastKeepAliveOk: null,
  lastLoginError: null,
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
    loggedInAt: session.loggedInAt,
    resolvedEndpoints: Object.fromEntries(resolvedEndpoints),
    savedAt: new Date().toISOString(),
  });
}

async function persistSession() {
  const body = serializeSession();
  const redis = await getPersistRedis();
  if (redis) {
    try { await redis.set(SESSION_REDIS_KEY, body); return; } catch { /* fall through to file */ }
  }
  try {
    fs.writeFileSync(SESSION_FILE, body, { mode: 0o600 });
  } catch (err) {
    console.warn('[SportyBet session] Could not persist session:', err.message);
  }
}

async function loadPersistedSession() {
  if (session.loaded) return;
  session.loaded = true;
  let body = null;
  const redis = await getPersistRedis();
  if (redis) {
    try { body = await redis.get(SESSION_REDIS_KEY); } catch { /* ignore */ }
  }
  if (!body) {
    try { body = fs.readFileSync(SESSION_FILE, 'utf8'); } catch { /* no saved session */ }
  }
  if (!body) return;
  try {
    const saved = JSON.parse(body);
    for (const [name, entry] of (saved.cookies || [])) {
      if (entry && entry.value && (!entry.expiresAt || entry.expiresAt > Date.now())) {
        session.cookies.set(name, entry);
      }
    }
    session.token = saved.token || null;
    session.tokenHeader = saved.tokenHeader || 'authorization';
    session.loggedInAt = saved.loggedInAt || null;
    for (const [kind, path] of Object.entries(saved.resolvedEndpoints || {})) {
      if (ENDPOINT_CANDIDATES[kind] && typeof path === 'string' && path) resolvedEndpoints.set(kind, path);
    }
    if (session.cookies.size || session.token) {
      console.log(`[SportyBet session] Restored persisted session (${session.cookies.size} cookies${session.token ? ' + token' : ''}, saved ${saved.savedAt || 'unknown'})`);
    }
  } catch (err) {
    console.warn('[SportyBet session] Ignoring unreadable persisted session:', err.message);
  }
}

function parseSetCookies(res) {
  let raw = [];
  try {
    if (typeof res.headers.getSetCookie === 'function') raw = res.headers.getSetCookie();
    else if (typeof res.headers.raw === 'function') raw = res.headers.raw()['set-cookie'] || [];
    else {
      const single = res.headers.get('set-cookie');
      if (single) raw = [single];
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
    const maxAge = String(line).match(/max-age=(\d+)/i);
    const expires = String(line).match(/expires=([^;]+)/i);
    if (maxAge) expiresAt = now + Number(maxAge[1]) * 1000;
    else if (expires) {
      const t = Date.parse(expires[1]);
      if (Number.isFinite(t)) expiresAt = t;
    }
    if (expiresAt && expiresAt <= now) session.cookies.delete(name);
    else session.cookies.set(name, { value, expiresAt });
  }
}

function cookieHeader() {
  const now = Date.now();
  const parts = [];
  for (const [name, entry] of session.cookies) {
    if (entry.expiresAt && entry.expiresAt <= now) { session.cookies.delete(name); continue; }
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
  const dedupeKey = upperMethod === 'GET' ? `${url}` : null;
  if (dedupeKey && inFlightGet.has(dedupeKey)) return inFlightGet.get(dedupeKey);

  const run = (async () => {
    await loadPersistedSession();

    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': SITE_ORIGIN,
      'Referer': `${SITE_ORIGIN}/ng/`,
      ...extraHeaders,
    };
    const cookies = cookieHeader();
    if (cookies) headers['Cookie'] = cookies;
    if (session.token) {
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

    if ((res.status === 401 || res.status === 403) && auth && retryAuth) {
      // Session died server-side. Log in again and retry the request once.
      console.warn(`[SportyBet session] ${endpoint} returned ${res.status}; refreshing session and retrying once`);
      await login({ force: true });
      return sportyRequest(endpoint, { method, params, body, auth, timeoutMs, retryAuth: false, extraHeaders });
    }

    if (!res.ok) {
      const err = sportyError(`SportyBet ${endpoint} -> ${res.status}: ${String(text).slice(0, 300)}`, 'SPORTYBET_HTTP', { status: res.status });
      throw err;
    }

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw sportyError(`SportyBet ${endpoint} returned invalid JSON`, 'SPORTYBET_NON_JSON');
    }
    if (payload && payload.status && String(payload.status).toLowerCase() !== 'success' && payload.error) {
      throw sportyError(`SportyBet ${endpoint}: ${payload.error}`, 'SPORTYBET_API', { payload });
    }
    return payload;
  })();

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

async function login({ force = false } = {}) {
  if (!credentialsConfigured()) {
    throw sportyError(
      'SportyBet dummy account is not configured. Set SPORTYBET_PHONE and SPORTYBET_PASSWORD on the server.',
      'SPORTYBET_NOT_CONFIGURED'
    );
  }
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    await loadPersistedSession();

    if (!force && (session.token || session.cookies.size > 0) && session.loggedInAt) {
      return { reused: true };
    }

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
    // arrives attached to a dead session.
    session.cookies.clear();
    session.token = null;

    const url = `${BASE_URL}${ENDPOINTS.login.startsWith('/') ? ENDPOINTS.login : `/${ENDPOINTS.login}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    let text;
    try {
      res = await rawFetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'Origin': SITE_ORIGIN,
          'Referer': `${SITE_ORIGIN}/ng/`,
        },
        body: JSON.stringify(body),
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

    parseSetCookies(res);

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html') || /^\s*<!doctype html|^\s*<html/i.test(text)) {
      throw classifyHtmlBlock(url, text);
    }

    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }

    if (!res.ok) {
      const detail = payload.message || payload.error || payload.msg || String(text).slice(0, 200);
      session.lastLoginError = `${res.status} ${detail}`;
      if (res.status === 404) {
        throw sportyError(
          `SportyBet login path ${ENDPOINTS.login} returned 404 "Resource not found" — the login route has moved. Capture the real login request from a Nigerian browser (DevTools > Network while logging in) and set SPORTYBET_ENDPOINT_LOGIN to its path.`,
          'SPORTYBET_AUTH_FAILED',
          { status: res.status }
        );
      }
      // Surface OTP requirements clearly: auto-renewal cannot pass an SMS challenge.
      const otp = /otp|verification code|one[- ]time/i.test(String(detail));
      throw sportyError(
        `SportyBet login rejected (${res.status}): ${detail}${otp ? ' — this account appears to require OTP; automatic session renewal is not possible while OTP is enabled.' : ''}`,
        'SPORTYBET_AUTH_FAILED',
        { status: res.status }
      );
    }

    const token = extractToken(payload);
    const failed = payload && payload.status && String(payload.status).toLowerCase() !== 'success' && (payload.error || payload.message);
    if (failed) {
      session.lastLoginError = String(payload.error || payload.message);
      throw sportyError(`SportyBet login rejected: ${payload.error || payload.message}`, 'SPORTYBET_AUTH_FAILED');
    }
    if (!token && session.cookies.size === 0) {
      session.lastLoginError = 'no token or session cookie in login response';
      throw sportyError(
        `SportyBet login returned 200 but no token/cookie. Response keys: ${Object.keys(payload || {}).join(',') || '(empty)'}. The login endpoint shape may have changed; check SPORTYBET_ENDPOINT_LOGIN.`,
        'SPORTYBET_AUTH_FAILED'
      );
    }

    session.token = token;
    session.loggedInAt = new Date().toISOString();
    session.lastLoginError = null;
    session.loginCount += 1;
    await persistSession();
    console.log(`[SportyBet session] Logged in dummy account (${session.cookies.size} cookies${token ? ' + token' : ''}) — login #${session.loginCount}`);
    return { reused: false, token: !!token, cookies: session.cookies.size };
  })();

  try {
    return await loginPromise;
  } finally {
    loginPromise = null;
  }
}

async function ensureSession() {
  await loadPersistedSession();
  if (session.token || session.cookies.size > 0) return;
  await login();
}

// Keep-alive: ping a light authenticated endpoint before cookies die, persist
// whatever set-cookie comes back, and re-login immediately when the session is
// already gone. This keeps the dummy-account session alive indefinitely as long
// as SportyBet honours sliding session renewal; hard server-side invalidations
// are healed by the automatic re-login on the next request.
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer || !credentialsConfigured()) return;
  const tick = async () => {
    try {
      await ensureSession();
      await sportyRequest(ENDPOINTS.userInfo, { auth: true, timeoutMs: 10000 });
      session.lastKeepAliveAt = new Date().toISOString();
      session.lastKeepAliveOk = true;
      await persistSession();
    } catch (err) {
      session.lastKeepAliveAt = new Date().toISOString();
      session.lastKeepAliveOk = false;
      if (err.code === 'SPORTYBET_GEO_BLOCKED' || err.code === 'SPORTYBET_BOT_CHALLENGE') {
        // Geo/bot blocks will not be fixed by re-login; stop hammering until config changes.
        console.warn(`[SportyBet session] keep-alive paused: ${err.message}`);
        return;
      }
      console.warn(`[SportyBet session] keep-alive failed (${err.message}); attempting re-login`);
      try { await login({ force: true }); }
      catch (loginErr) { console.warn(`[SportyBet session] re-login failed: ${loginErr.message}`); }
    }
  };
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
    loggedIn: !!(session.token || session.cookies.size),
    hasToken: !!session.token,
    cookies,
    loggedInAt: session.loggedInAt,
    loginCount: session.loginCount,
    lastKeepAliveAt: session.lastKeepAliveAt,
    lastKeepAliveOk: session.lastKeepAliveOk,
    lastLoginError: session.lastLoginError,
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
  if (CACHE_BUSTER) params._t = Date.now();
  return params;
}

async function fetchPrematchPage(sportId, page, pageSize, { marketIds } = {}) {
  return requestWithResolution('prematch', {
    params: listParams(sportId, page, pageSize, marketIds),
    auth: false,
  });
}

// The live/in-play board. When the dummy account is configured the session is
// attached (some live content is served at a higher trust level to logged-in
// users); without credentials the anonymous board is used.
async function fetchLivePage(sportId, page, pageSize, { marketIds } = {}) {
  const useSession = credentialsConfigured();
  if (useSession) {
    try { await ensureSession(); } catch { /* anonymous live board still works */ }
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
  const method = String(process.env.SPORTYBET_ENDPOINT_EVENT_METHOD || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  return requestWithResolution('eventDetail', {
    method,
    params: method === 'GET' ? { [PARAM_EVENT_ID || 'eventId']: eventId } : {},
    body: method === 'POST' ? { [PARAM_EVENT_ID || 'eventId']: eventId } : undefined,
    auth: false,
  });
}

async function lookupBooking(shareCode, { fresh = false } = {}) {
  const params = { shareCode };
  if (fresh) params._ts = Date.now();
  // Booking-code lookup is public on SportyBet; attach the session when we have
  // one anyway so the request benefits from the same trust level as the site.
  const hasSession = !!(session.token || session.cookies.size);
  return sportyRequest(ENDPOINTS.bookingLookup, { params, auth: hasSession });
}

async function createBookingCode(selections) {
  await ensureSession();
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
  startKeepAlive,
  sessionStatus,
  credentialsConfigured,
  setFetchForTesting,
  ENDPOINT_CANDIDATES,
  _session: session,
  _resolvedEndpoints: resolvedEndpoints,
};
