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
const LOGIN_ID = String(process.env.SPORTYSOCIAL_LOGIN_ID || '').trim();
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
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text: text.slice(0, 500) };
  }, `${BASE}${SUGGESTED_FRAGMENT}?size=20&_t=${Date.now()}`);
}

function isGoodFeed(result) {
  return result?.status === 200 && result?.json?.bizCode === 10000 && Array.isArray(result?.json?.data?.items);
}

async function clickFirstVisible(page, locators) {
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

async function ensureLoggedIn(page) {
  let probe = await feedJson(page).catch(() => null);
  if (isGoodFeed(probe)) return probe;

  await page.goto(`${BASE}/ng/m/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);

  await clickFirstVisible(page, [
    page.getByRole('button', { name: /^log\s*in$/i }),
    page.getByRole('link', { name: /^log\s*in$/i }),
    page.getByText(/^log\s*in$/i),
    page.getByText(/^login$/i),
  ]);
  await page.waitForTimeout(900);

  const phone = page.locator([
    'input[type="tel"]',
    'input[autocomplete="tel"]',
    'input[placeholder*="Mobile" i]',
    'input[placeholder*="Phone" i]',
    'input[name*="mobile" i]',
    'input[name*="phone" i]'
  ].join(',')).first();
  const password = page.locator('input[type="password"], input[name*="password" i]').first();

  if (!(await phone.count()) || !(await password.count())) {
    throw new Error('LOGIN_FORM_NOT_FOUND: SportyBet login form was not detected. The site UI may have changed.');
  }

  await phone.fill(LOGIN_ID);
  await password.fill(PASSWORD);

  const clicked = await clickFirstVisible(page, [
    page.getByRole('button', { name: /^log\s*in$/i }),
    page.getByRole('button', { name: /^login$/i }),
    page.locator('button[type="submit"]'),
  ]);
  if (!clicked) throw new Error('LOGIN_BUTTON_NOT_FOUND: SportyBet login submit button was not detected.');

  await page.waitForTimeout(2500);
  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 12000);
  if (/captcha|security verification|verify you are human|robot/i.test(bodyText)) {
    throw new Error('VERIFICATION_REQUIRED: SportyBet requested CAPTCHA/security verification. Collector will not bypass it.');
  }
  if (/one[- ]?time password|\botp\b|verification code/i.test(bodyText) && !/forgot password/i.test(bodyText)) {
    throw new Error('OTP_REQUIRED: SportyBet requested an OTP. Collector will not bypass it.');
  }

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    probe = await feedJson(page).catch(() => null);
    if (isGoodFeed(probe)) return probe;
    await page.waitForTimeout(1200);
  }
  throw new Error(`LOGIN_FAILED: authenticated SportySocial feed was unavailable after login (HTTP ${probe?.status || 'unknown'}).`);
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
  if (!isGoodFeed(first)) throw new Error(`SPORTYSOCIAL_FEED_FAILED: HTTP ${first?.status || 'unknown'}`);
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
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
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
    await page.goto(CODE_HUB_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await ensureLoggedIn(page);
    const collected = await collectSportySocial(page);
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
