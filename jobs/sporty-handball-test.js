/*
 * Plot207 SportyBet Handball discovery test.
 *
 * Purpose: prove that the existing dummy SportyBet login can open the
 * Handball prematch surface and expose public fixture / market identifiers.
 * This script DOES NOT place a bet, submit a stake, touch balances, or bypass
 * CAPTCHA/OTP/security challenges.
 *
 * Required GitHub Secrets:
 *   SPORTYSOCIAL_LOGIN_ID
 *   SPORTYSOCIAL_PASSWORD
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = 'https://www.sportybet.com';
const LOGIN_ID_RAW = String(process.env.SPORTYSOCIAL_LOGIN_ID || '').trim();
const PASSWORD = String(process.env.SPORTYSOCIAL_PASSWORD || '');
const HEADLESS = String(process.env.SPORTY_HANDBALL_HEADLESS || 'true').toLowerCase() !== 'false';
const MAX_EVENTS = Math.max(1, Math.min(25, Number(process.env.SPORTY_HANDBALL_MAX_EVENTS || 10)));

// This authenticated endpoint is already used by the existing SportySocial
// collector only as a harmless login/session probe.
const LOGIN_PROBE_URL = `${BASE}/api/ng/orders/socialpage/my/suggested?size=1&_t=${Date.now()}`;

function normalizeNigeriaLoginId(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) digits = digits.slice(3);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}
const LOGIN_ID = normalizeNigeriaLoginId(LOGIN_ID_RAW);

function requireConfig() {
  const missing = [];
  if (!LOGIN_ID) missing.push('SPORTYSOCIAL_LOGIN_ID');
  if (!PASSWORD) missing.push('SPORTYSOCIAL_PASSWORD');
  if (missing.length) throw new Error(`Missing required GitHub secrets: ${missing.join(', ')}`);
}

function clean(v, max = 180) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(raw || '').split('?')[0].slice(0, 300);
  }
}

async function loginProbe(page) {
  const response = await page.context().request.get(LOGIN_PROBE_URL, {
    headers: {
      accept: 'application/json',
      clientid: 'wap',
      platform: 'wap',
      operid: '2',
      referer: `${BASE}/ng/m/`,
    },
    timeout: 30000,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {
    status: response.status(),
    ok: response.status() === 200 && json?.bizCode === 10000,
  };
}

function identifierLocators(frame) {
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

async function firstVisible(locators, timeout = 700) {
  for (const loc of locators) {
    try {
      if (await loc.count() && await loc.first().isVisible({ timeout })) return loc.first();
    } catch {}
  }
  return null;
}

async function findLoginFrame(page) {
  for (const frame of page.frames()) {
    const id = await firstVisible(identifierLocators(frame), 500);
    const pw = await firstVisible(passwordLocators(frame), 500);
    if (id || pw) return { frame, id, pw };
  }
  return null;
}

async function clickFirst(frame, locators) {
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

async function submitLogin(frame) {
  return clickFirst(frame, [
    frame.getByRole('button', { name: /^log\s*in$/i }),
    frame.getByRole('button', { name: /^login$/i }),
    frame.getByRole('button', { name: /^continue$/i }),
    frame.getByRole('button', { name: /^next$/i }),
    frame.locator('button[type="submit"]'),
    frame.locator('input[type="submit"]'),
  ]);
}

async function openLoginForm(page, surfaceUrl) {
  await page.goto(surfaceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);
  let found = await findLoginFrame(page);
  if (found) return found;

  for (const frame of page.frames()) {
    const clicked = await clickFirst(frame, [
      frame.getByRole('button', { name: /^log\s*in$/i }),
      frame.getByRole('link', { name: /^log\s*in$/i }),
      frame.getByText(/^log\s*in$/i),
      frame.getByText(/^login$/i),
      frame.locator('button:has-text("Log In")'),
      frame.locator('a:has-text("Log In")'),
    ]);
    if (clicked) {
      await page.waitForTimeout(1300);
      found = await findLoginFrame(page);
      if (found) return found;
    }
  }
  return null;
}

async function tryLogin(page, surfaceUrl) {
  let found = await openLoginForm(page, surfaceUrl);
  if (!found) return false;
  let { frame, id, pw } = found;

  if (!id) id = await firstVisible(identifierLocators(frame));
  if (id) await id.fill(LOGIN_ID);

  if (!pw) {
    await submitLogin(frame).catch(() => false);
    await page.waitForTimeout(1000);
    const next = await findLoginFrame(page);
    if (next) {
      frame = next.frame;
      pw = next.pw || await firstVisible(passwordLocators(frame));
    }
  }
  if (!pw) return false;

  await pw.fill(PASSWORD);
  const submitted = await submitLogin(frame);
  if (!submitted) {
    try { await pw.press('Enter'); } catch {}
  }
  await page.waitForTimeout(2500);

  const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 10000);
  if (/captcha|security verification|verify you are human|robot/i.test(body)) {
    throw new Error('VERIFICATION_REQUIRED: SportyBet requested CAPTCHA/security verification. This test will not bypass it.');
  }
  if (/one[- ]?time password|\botp\b|verification code/i.test(body) && !/forgot password/i.test(body)) {
    throw new Error('OTP_REQUIRED: SportyBet requested an OTP. This test will not bypass it.');
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const probe = await loginProbe(page).catch(() => null);
    if (probe?.ok) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function ensureLoggedIn(page) {
  const first = await loginProbe(page).catch(() => null);
  if (first?.ok) return;

  const surfaces = [
    `${BASE}/ng/lite/login?fromUrl=%2Fng%2Flite`,
    `${BASE}/ng/lite/`,
    `${BASE}/ng/m/`,
    `${BASE}/ng/liveResult`,
  ];
  for (const url of surfaces) {
    const ok = await tryLogin(page, url).catch((err) => {
      if (/VERIFICATION_REQUIRED|OTP_REQUIRED/.test(String(err?.message || err))) throw err;
      return false;
    });
    if (ok) return;
  }
  throw new Error('LOGIN_FAILED: existing dummy SportyBet credentials could not authenticate on the supported login surfaces.');
}

function getAny(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return null;
}

function teamName(v) {
  if (!v) return null;
  if (typeof v === 'string') return clean(v, 120);
  if (typeof v === 'object') return clean(v.name || v.teamName || v.shortName || v.displayName, 120);
  return null;
}

function normalizeEventCandidate(obj, sourceUrl) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const eventId = getAny(obj, ['eventId', 'event_id', 'id', 'matchId', 'match_id']);
  const sportId = getAny(obj, ['sportId', 'sport_id']);
  const sport = getAny(obj, ['sportName', 'sport', 'sportDesc']);
  const homeRaw = getAny(obj, ['homeTeamName', 'homeName', 'homeTeam', 'home', 'competitor1']);
  const awayRaw = getAny(obj, ['awayTeamName', 'awayName', 'awayTeam', 'away', 'competitor2']);
  const home = teamName(homeRaw);
  const away = teamName(awayRaw);

  // Common SportyBet/Sportradar event objects also expose competitors[]
  let homeFromCompetitors = null;
  let awayFromCompetitors = null;
  const competitors = Array.isArray(obj.competitors) ? obj.competitors : [];
  for (const c of competitors) {
    const qualifier = String(c?.qualifier || c?.type || '').toLowerCase();
    if (qualifier.includes('home')) homeFromCompetitors = teamName(c);
    if (qualifier.includes('away')) awayFromCompetitors = teamName(c);
  }

  const homeName = home || homeFromCompetitors;
  const awayName = away || awayFromCompetitors;
  const looksHandball = /handball/i.test(String(sport || '')) || /handball/i.test(JSON.stringify({ sportId, category: obj.category, tournament: obj.tournament }).slice(0, 500));
  const hasTeams = Boolean(homeName && awayName);
  const hasEventId = Boolean(eventId && /(?:sr:match:|match|event|\d{4,})/i.test(String(eventId)));
  if (!hasTeams || (!hasEventId && !looksHandball)) return null;

  return {
    sport: clean(sport || (looksHandball ? 'Handball' : null), 60),
    sportId: clean(sportId, 80),
    eventId: clean(eventId, 100),
    gameId: clean(getAny(obj, ['gameId', 'game_id']), 80),
    homeTeamName: homeName,
    awayTeamName: awayName,
    tournament: clean(
      typeof obj.tournament === 'object' ? (obj.tournament?.name || obj.tournament?.tournamentName) :
      getAny(obj, ['tournamentName', 'leagueName', 'competitionName', 'tournament', 'league']), 140
    ),
    kickoffTime: clean(getAny(obj, ['kickoffTime', 'startTime', 'start_time', 'scheduled', 'startTimestamp']), 80),
    sourceUrl: cleanUrl(sourceUrl),
  };
}

function normalizeMarketCandidate(obj, sourceUrl) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const marketId = getAny(obj, ['marketId', 'market_id', 'id']);
  const marketDesc = getAny(obj, ['marketDesc', 'marketName', 'name', 'desc']);
  const outcomes = getAny(obj, ['outcomes', 'outcomeList', 'selections']);
  if (!marketId || !Array.isArray(outcomes) || !outcomes.length) return null;

  const normalizedOutcomes = outcomes.slice(0, 20).map((o) => ({
    outcomeId: clean(getAny(o, ['outcomeId', 'outcome_id', 'id']), 100),
    outcomeDesc: clean(getAny(o, ['outcomeDesc', 'name', 'desc', 'label']), 120),
    odds: clean(getAny(o, ['odds', 'price', 'decimalOdds']), 40),
    specifier: clean(getAny(o, ['specifier', 'specialOddsValue', 'line']), 100),
  })).filter((o) => o.outcomeId || o.outcomeDesc || o.odds);
  if (!normalizedOutcomes.length) return null;

  return {
    marketId: clean(marketId, 100),
    marketDesc: clean(marketDesc, 140),
    specifier: clean(getAny(obj, ['specifier', 'specialOddsValue', 'line']), 100),
    outcomes: normalizedOutcomes,
    sourceUrl: cleanUrl(sourceUrl),
  };
}

function walkJson(value, sourceUrl, events, markets, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const row of value.slice(0, 1500)) walkJson(row, sourceUrl, events, markets, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const event = normalizeEventCandidate(value, sourceUrl);
  if (event) {
    const key = `${event.eventId || ''}|${event.homeTeamName}|${event.awayTeamName}`;
    if (!events.has(key)) events.set(key, event);
  }
  const market = normalizeMarketCandidate(value, sourceUrl);
  if (market) {
    const key = `${market.marketId}|${market.marketDesc || ''}|${market.specifier || ''}|${market.outcomes.map(x => x.outcomeId).join(',')}`;
    if (!markets.has(key)) markets.set(key, market);
  }

  for (const [k, v] of Object.entries(value)) {
    if (/password|passwd|cookie|authorization|token|session|account|balance|deposit|withdraw/i.test(k)) continue;
    walkJson(v, sourceUrl, events, markets, depth + 1);
  }
}

async function collectHandball(page) {
  const events = new Map();
  const markets = new Map();
  const jsonResponses = [];

  const capture = async (response) => {
    try {
      const contentType = String(response.headers()['content-type'] || '');
      if (!/json/i.test(contentType)) return;
      const u = response.url();
      // Capture only responses generated while browsing the Handball sports surface.
      const json = await response.json();
      jsonResponses.push({ url: cleanUrl(u), status: response.status(), keys: Object.keys(json || {}).slice(0, 20) });
      walkJson(json, u, events, markets);
    } catch {}
  };
  page.on('response', capture);

  const candidateUrls = [
    `${BASE}/ng/m/sport/handball?sort=0`,
    `${BASE}/ng/m/sport/handball/today`,
  ];

  let openedUrl = null;
  for (const url of candidateUrls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      openedUrl = page.url();
      await page.waitForTimeout(4500);
      await page.mouse.wheel(0, 3500).catch(() => {});
      await page.waitForTimeout(2000);
      if (events.size >= 1) break;
    } catch {}
  }

  // If direct routing changed, use the normal Sports page and click the visible Handball entry.
  if (!events.size) {
    await page.goto(`${BASE}/ng/m/sport`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2000);
    for (const frame of page.frames()) {
      const locators = [
        frame.getByText(/^Handball$/i),
        frame.getByRole('link', { name: /Handball/i }),
        frame.getByRole('button', { name: /Handball/i }),
        frame.locator('a:has-text("Handball")'),
      ];
      const clicked = await clickFirst(frame, locators).catch(() => false);
      if (clicked) {
        await page.waitForTimeout(5000);
        openedUrl = page.url();
        await page.mouse.wheel(0, 3500).catch(() => {});
        await page.waitForTimeout(1800);
        break;
      }
    }
  }

  page.off('response', capture);

  // Keep only event rows that look like Handball if a sport label exists.
  const eventRows = [...events.values()].filter((e) => !e.sport || /handball/i.test(e.sport)).slice(0, MAX_EVENTS);
  const marketRows = [...markets.values()].slice(0, 80);
  return { openedUrl, eventRows, marketRows, jsonResponses: jsonResponses.slice(0, 120) };
}

async function writeDiagnostics(page, result) {
  fs.mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/handball-test-page.png', fullPage: true }).catch(() => {});
  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 12000);
  fs.writeFileSync('artifacts/handball-discovery.json', JSON.stringify({
    openedUrl: result?.openedUrl || cleanUrl(page.url()),
    pageTitle: await page.title().catch(() => ''),
    bodyPreview: bodyText.replace(/\+?234\s*\d{7,}/g, '[PHONE REDACTED]').slice(0, 5000),
    events: result?.eventRows || [],
    markets: result?.marketRows || [],
    jsonResponses: result?.jsonResponses || [],
  }, null, 2));
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
  let result = null;
  try {
    console.log('[Handball Test] Checking existing SportyBet dummy-account login');
    await ensureLoggedIn(page);
    console.log('[Handball Test] LOGIN SUCCESS');
    console.log('[Handball Test] Opening SportyBet Handball prematch section');
    result = await collectHandball(page);
    await writeDiagnostics(page, result);

    console.log(`[Handball Test] Handball fixture candidates found: ${result.eventRows.length}`);
    result.eventRows.forEach((row, i) => {
      console.log(JSON.stringify({
        n: i + 1,
        sport: row.sport || 'Handball',
        eventId: row.eventId,
        sportId: row.sportId,
        gameId: row.gameId,
        home: row.homeTeamName,
        away: row.awayTeamName,
        tournament: row.tournament,
        kickoffTime: row.kickoffTime,
      }));
    });

    console.log(`[Handball Test] Market structures observed: ${result.marketRows.length}`);
    result.marketRows.slice(0, 12).forEach((market, i) => {
      console.log(JSON.stringify({
        market: i + 1,
        marketId: market.marketId,
        marketDesc: market.marketDesc,
        specifier: market.specifier,
        outcomes: market.outcomes.slice(0, 6),
      }));
    });

    if (!result.eventRows.length) {
      throw new Error('NO_HANDBALL_FIXTURES_DISCOVERED: Login worked, but this first discovery pass could not extract Handball fixture objects. Download the handball-discovery artifact; it contains a safe network/page diagnostic for the next adjustment.');
    }

    console.log('[Handball Test] SUCCESS: authenticated Handball fixtures were discovered. Next step will be precise market/outcome mapping, then Volleyball.');
  } finally {
    if (result) await writeDiagnostics(page, result).catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[Handball Test] FAILED: ${String(err?.message || err).slice(0, 700)}`);
  process.exit(1);
});
