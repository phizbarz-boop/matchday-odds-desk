/*
 * SportySocial twice-daily collector.
 * Runs in GitHub Actions with a dedicated empty/dummy SportyBet account.
 * Credentials stay in GitHub Secrets. Only sanitized public Code Hub records
 * are sent to Matchday. This script does not place bets or access balances.
 * It does not bypass CAPTCHA, OTP, or other verification challenges.
 */
const { chromium } = require('playwright');

const BASE = 'https://www.sportybet.com';
const CODE_HUB_URL = `${BASE}/ng/m/code-hub/following?tab=booking_codes`;
const SUGGESTED_FRAGMENT = '/api/ng/orders/socialpage/my/suggested';
const MATCHDAY_BASE_URL = String(process.env.MATCHDAY_BASE_URL || 'https://matchday-odds-desk.onrender.com').replace(/\/$/, '');
const LOGIN_ID_RAW = String(process.env.SPORTYSOCIAL_LOGIN_ID || '').trim();

function normalizeNigeriaLoginId(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) digits = digits.slice(3);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

const LOGIN_ID = normalizeNigeriaLoginId(LOGIN_ID_RAW);
const PASSWORD = String(process.env.SPORTYSOCIAL_PASSWORD || '');
const COPY_HUB_SECRET = String(process.env.COPY_HUB_SECRET || '');
const MAX_PAGES = Math.max(1, Math.min(20, Number(process.env.SPORTYSOCIAL_MAX_PAGES || 5)));
const HEADLESS = String(process.env.SPORTYSOCIAL_HEADLESS || 'true').toLowerCase() !== 'false';

function requireConfig() {
  const missing = [];
  if (!LOGIN_ID) missing.push('SPORTYSOCIAL_LOGIN_ID');
  if (!PASSWORD) missing.push('SPORTYSOCIAL_PASSWORD');
  if (!COPY_HUB_SECRET) missing.push('COPY_HUB_SECRET');
  if (missing.length) throw new Error(`Missing required secrets: ${missing.join(', ')}`);
}

function cleanString(v, max = 180) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function sanitizeSelection(row = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return {};
  const out = {};
  const blocked = /(password|passwd|cookie|authorization|access.?token|refresh.?token|session|phone|mobile|email|account.?number|balance|deposit|withdraw)/i;
  for (const [key, value] of Object.entries(row)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || blocked.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 220);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function sanitizeItem(raw = {}) {
  const code = raw?.code && typeof raw.code === 'object' ? raw.code : null;
  if (!code) return null;
  const shareCode = cleanString(code.shareCode, 24).toUpperCase();
  const nickname = cleanString(raw.nickname || raw.username || raw.displayName, 80);
  const userId = cleanString(raw.userId || code.userId, 100);
  if (!shareCode || !nickname || !userId) return null;
  return {
    nickname,
    avatar: cleanString(raw.avatar, 240) || null,
    userType: cleanString(raw.userType, 30) || null,
    followersCount: Number.isFinite(Number(raw.followersCount)) ? Number(raw.followersCount) : null,
    isFollowed: Boolean(raw.isFollowed),
    userId,
    code: {
      shareCode,
      orderType: Number.isFinite(Number(code.orderType)) ? Number(code.orderType) : null,
      foldsAmount: Number.isFinite(Number(code.foldsAmount)) ? Number(code.foldsAmount) : null,
      totalOdds: Number.isFinite(Number(code.totalOdds)) ? Number(code.totalOdds) : null,
      userId,
      status: Number.isFinite(Number(code.status)) ? Number(code.status) : null,
      deadline: Number.isFinite(Number(code.deadline)) ? Number(code.deadline) : null,
      createTime: Number.isFinite(Number(code.createTime)) ? Number(code.createTime) : null,
      popularity: Number.isFinite(Number(code.popularity)) ? Number(code.popularity) : null,
      isBetBuilder: Boolean(code.isBetBuilder),
      source: Number.isFinite(Number(code.source)) ? Number(code.source) : null,
      shareCodeDetail: Array.isArray(code.shareCodeDetail) ? code.shareCodeDetail.slice(0, 40).map(sanitizeSelection) : [],
    },
  };
}

async function feedJson(page) {
  // IMPORTANT: Do not call window.fetch() inside SportyBet's page. Their WAP
  // bundle wraps/patches page requests and can throw its own SyntaxError in
  // headless browsers. BrowserContext.request shares the same cookie jar as
  // the page, so authenticated requests still work without executing site JS.
  const url = `${BASE}${SUGGESTED_FRAGMENT}?size=20&_t=${Date.now()}`;
  const response = await page.context().request.get(url, {
    headers: {
      accept: 'application/json',
      clientid: 'wap',
      platform: 'wap',
      operid: '2',
      referer: CODE_HUB_URL,
    },
    timeout: 30000,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status(), json, text: text.slice(0, 500) };
}

function isGoodFeed(result) {
  return result?.status === 200 && result?.json?.bizCode === 10000 && Array.isArray(result?.json?.data?.items);
}

async function clickFirstVisible(pageOrFrame, locators) {
  for (const loc of locators) {
    try {
      if (await loc.count() && await loc.first().isVisible({ timeout: 800 })) {
        await loc.first().click();
        return true;
      }
    } catch {}
  }
  return false;
}

function loginIdentifierLocators(frame) {
  return [
    frame.locator('input[type="tel"]'),
    frame.locator('input[autocomplete="tel"]'),
    frame.locator('input[autocomplete="username"]'),
    frame.locator('input[placeholder*="Mobile" i]'),
    frame.locator('input[placeholder*="Phone" i]'),
    frame.locator('input[placeholder*="Username" i]'),
    frame.locator('input[name*="mobile" i]'),
    frame.locator('input[name*="phone" i]'),
    frame.locator('input[name*="username" i]'),
  ];
}

function passwordLocators(frame) {
  return [
    frame.locator('input[type="password"]'),
    frame.locator('input[autocomplete="current-password"]'),
    frame.locator('input[name*="password" i]'),
    frame.locator('input[placeholder*="Password" i]'),
  ];
}

async function firstVisibleLocator(locators, timeout = 700) {
  for (const loc of locators) {
    try {
      if (await loc.count() && await loc.first().isVisible({ timeout })) return loc.first();
    } catch {}
  }
  return null;
}

async function findLoginFrame(page) {
  for (const frame of page.frames()) {
    const id = await firstVisibleLocator(loginIdentifierLocators(frame), 500);
    const pw = await firstVisibleLocator(passwordLocators(frame), 500);
    if (id || pw) return { frame, id, pw };
  }
  return null;
}

async function findLoginHref(page) {
  for (const frame of page.frames()) {
    const candidates = [
      frame.getByRole('link', { name: /^log\s*in$/i }),
      frame.locator('a:has-text("Log In")'),
      frame.locator('a:has-text("Login")'),
    ];
    for (const loc of candidates) {
      try {
        if (!await loc.count()) continue;
        const href = await loc.first().getAttribute('href');
        if (href) return new URL(href, frame.url() || page.url()).toString();
      } catch {}
    }
  }
  return null;
}

async function clickLoginEntry(page) {
  for (const frame of page.frames()) {
    const clicked = await clickFirstVisible(frame, [
      frame.getByRole('button', { name: /^log\s*in$/i }),
      frame.getByRole('link', { name: /^log\s*in$/i }),
      frame.getByText(/^log\s*in$/i),
      frame.getByText(/^login$/i),
      frame.locator('button:has-text("Log In")'),
      frame.locator('a:has-text("Log In")'),
    ]);
    if (clicked) return true;
  }
  return false;
}

async function openLoginForm(page, surfaceUrl) {
  await page.goto(surfaceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);

  let found = await findLoginFrame(page);
  if (found) return found;

  let loginHref = await findLoginHref(page);
  if (!loginHref && /\/ng\/lite\/?(?:$|\?)/i.test(page.url())) {
    loginHref = `${BASE}/ng/lite/login?fromUrl=%2Fng%2Flite`;
  }
  if (loginHref) {
    await page.goto(loginHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800);
    found = await findLoginFrame(page);
    if (found) return found;
  }

  const clicked = await clickLoginEntry(page).catch(() => false);
  if (clicked) {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1600);
    found = await findLoginFrame(page);
    if (found) return found;
  }

  return null;
}

async function submitLogin(frame) {
  return clickFirstVisible(frame, [
    frame.getByRole('button', { name: /^log\s*in$/i }),
    frame.getByRole('button', { name: /^login$/i }),
    frame.getByRole('button', { name: /^continue$/i }),
    frame.getByRole('button', { name: /^next$/i }),
    frame.locator('button[type="submit"]'),
    frame.locator('input[type="submit"]'),
  ]);
}

async function tryLoginSurface(page, url) {
  let found = await openLoginForm(page, url);
  if (!found) return false;

  let { frame, id, pw } = found;
  if (!id) id = await firstVisibleLocator(loginIdentifierLocators(frame));
  if (id) {
    await id.fill(LOGIN_ID);
  }

  // Some SportyBet surfaces reveal the password field only after the mobile/login ID step.
  if (!pw) {
    await submitLogin(frame).catch(() => false);
    await page.waitForTimeout(1000);
    const next = await findLoginFrame(page);
    if (next) {
      frame = next.frame;
      pw = next.pw || await firstVisibleLocator(passwordLocators(frame));
    }
  }
  if (!pw) return false;

  await pw.fill(PASSWORD);
  const submitted = await submitLogin(frame);
  if (!submitted) {
    try { await pw.press('Enter'); } catch {}
  }
  await page.waitForTimeout(2500);

  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 12000);
  if (/captcha|security verification|verify you are human|robot/i.test(bodyText)) {
    throw new Error('VERIFICATION_REQUIRED: SportyBet requested CAPTCHA/security verification. Collector will not bypass it.');
  }
  if (/one[- ]?time password|\botp\b|verification code/i.test(bodyText) && !/forgot password/i.test(bodyText)) {
    throw new Error('OTP_REQUIRED: SportyBet requested an OTP. Collector will not bypass it.');
  }

  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) {
    const probe = await feedJson(page).catch(() => null);
    if (isGoodFeed(probe)) return true;
    await page.waitForTimeout(1100);
  }
  return false;
}

async function writeLoginDiagnostics(page) {
  try {
    const fs = require('fs');
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/sportysocial-login-failure.png', fullPage: true });
    const frames = [];
    for (const frame of page.frames()) {
      const inputs = await frame.locator('input').evaluateAll((nodes) => nodes.slice(0, 30).map((n) => ({
        type: n.getAttribute('type') || '',
        name: n.getAttribute('name') || '',
        placeholder: n.getAttribute('placeholder') || '',
        autocomplete: n.getAttribute('autocomplete') || '',
      }))).catch(() => []);
      const buttons = await frame.locator('button, a').evaluateAll((nodes) => nodes.slice(0, 40).map((n) => (n.textContent || '').trim()).filter(Boolean)).catch(() => []);
      const links = await frame.locator('a').evaluateAll((nodes) => nodes.slice(0, 40).map((n) => ({
        text: (n.textContent || '').trim().slice(0, 80),
        href: n.getAttribute('href') || '',
      })).filter((x) => x.text || x.href)).catch(() => []);
      frames.push({ url: frame.url(), inputs, buttons, links });
    }
    fs.writeFileSync('artifacts/sportysocial-login-diagnostics.json', JSON.stringify({
      url: page.url(),
      title: await page.title().catch(() => ''),
      frames,
    }, null, 2));
  } catch {}
}

async function ensureLoggedIn(page) {
  let probe = await feedJson(page).catch(() => null);
  if (isGoodFeed(probe)) return probe;

  // SportyBet exposes more than one login surface. GitHub/headless sessions do not
  // always render the same mobile modal as a normal browser, so try several normal
  // site entry points without bypassing any verification challenge.
  const loginSurfaces = [
    `${BASE}/ng/lite/login?fromUrl=%2Fng%2Flite`,
    `${BASE}/ng/lite/`,
    `${BASE}/ng/m/`,
    `${BASE}/ng/liveResult`,
  ];

  for (const url of loginSurfaces) {
    const ok = await tryLoginSurface(page, url).catch((err) => {
      if (/VERIFICATION_REQUIRED|OTP_REQUIRED/.test(String(err?.message || err))) throw err;
      return false;
    });
    if (ok) {
      probe = await feedJson(page).catch(() => null);
      if (isGoodFeed(probe)) return probe;
    }
  }

  await writeLoginDiagnostics(page);
  throw new Error('LOGIN_FAILED: SportyBet login could not be completed after opening the direct Lite login page plus mobile/desktop fallbacks. A safe diagnostic artifact was saved by the workflow.');
}

async function collectSportySocial(page) {
  const items = new Map();
  let feedResponses = 0;
  let lastResponseAt = 0;

  const capture = async (response) => {
    try {
      if (!response.url().includes(SUGGESTED_FRAGMENT)) return;
      const json = await response.json();
      if (json?.bizCode !== 10000 || !Array.isArray(json?.data?.items)) return;
      feedResponses += 1;
      lastResponseAt = Date.now();
      for (const raw of json.data.items) {
        const item = sanitizeItem(raw);
        if (!item) continue;
        items.set(`${item.userId}:${item.code.shareCode}`, item);
      }
    } catch {}
  };
  page.on('response', capture);

  await page.goto(CODE_HUB_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  // Direct authenticated fetch guarantees at least the first page even if browser caching
  // prevents the page's own first request from being observed.
  const first = await feedJson(page);
  if (!isGoodFeed(first)) {
    const detail = first?.json?.message || first?.json?.error || first?.text || 'unexpected response';
    throw new Error(`SPORTYSOCIAL_FEED_FAILED: HTTP ${first?.status || 'unknown'} ${String(detail).slice(0, 180)}`);
  }
  feedResponses += 1;
  for (const raw of first.json.data.items) {
    const item = sanitizeItem(raw);
    if (item) items.set(`${item.userId}:${item.code.shareCode}`, item);
  }

  // Let SportyBet's own Code Hub lazy-loader request later pages. We don't invent or
  // reverse-engineer cursor values; we simply observe normal page behavior.
  for (let i = 1; i < MAX_PAGES; i++) {
    const beforeCount = items.size;
    const beforeResponses = feedResponses;
    // Avoid page.evaluate here too; use native browser input so SportyBet's
    // page JS cannot turn a harmless collector action into a Playwright error.
    await page.mouse.wheel(0, 7000).catch(() => {});
    await page.waitForTimeout(2200);
    if (items.size === beforeCount && feedResponses === beforeResponses) {
      // Nudge once more in case virtualized content needs a second scroll.
      await page.mouse.wheel(0, 5000).catch(() => {});
      await page.waitForTimeout(1600);
    }
    if (items.size === beforeCount && feedResponses === beforeResponses) break;
  }

  page.off('response', capture);
  return { items: [...items.values()], feedResponses, lastResponseAt };
}

async function postToMatchday(items) {
  const response = await fetch(`${MATCHDAY_BASE_URL}/api/copy/sportysocial/import-batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-copy-hub-secret': COPY_HUB_SECRET,
      'user-agent': 'matchday-sportysocial-collector/1.0',
    },
    body: JSON.stringify({ items, collectedAt: new Date().toISOString() }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(`MATCHDAY_IMPORT_FAILED: HTTP ${response.status} ${json?.error || text.slice(0, 160)}`);
  return json;
}

async function main() {
  requireConfig();
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'en-NG',
    timezoneId: 'Africa/Lagos',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  });
  const page = await context.newPage();
  try {
    console.log('[SportySocial] Opening Code Hub');
    await page.goto(CODE_HUB_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('[SportySocial] Checking/authenticating session');
    await ensureLoggedIn(page);
    console.log('[SportySocial] Authenticated feed confirmed');
    const collected = await collectSportySocial(page);
    console.log(`[SportySocial] Collected ${collected.items.length} unique punter/code records`);
    if (!collected.items.length) throw new Error('NO_SPORTYSOCIAL_ITEMS: authenticated Code Hub returned no usable punter/code records.');
    const imported = await postToMatchday(collected.items);
    console.log(JSON.stringify({
      ok: true,
      collected: collected.items.length,
      feedResponses: collected.feedResponses,
      imported: {
        checked: imported.checked,
        added: imported.added,
        duplicates: imported.duplicates,
        originalsAdded: imported.originalsAdded,
        repostsAdded: imported.repostsAdded,
        unknownOriginAdded: imported.unknownOriginAdded,
        invalid: imported.invalid,
      }
    }));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`SportySocial collector failed: ${String(err?.message || err).slice(0, 500)}`);
  process.exit(1);
});
