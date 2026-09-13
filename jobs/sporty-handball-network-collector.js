
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LOGIN_ID = process.env.SPORTYSOCIAL_LOGIN_ID || '';
const PASSWORD = process.env.SPORTYSOCIAL_PASSWORD || '';

const OUT_DIR = path.join(process.cwd(), 'handball-discovery-v2');
fs.mkdirSync(OUT_DIR, { recursive: true });

function safeJsonWrite(name, data) {
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data, null, 2));
}

function normalizeText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function walk(obj, cb, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
  seen.add(obj);
  cb(obj);
  if (Array.isArray(obj)) {
    for (const x of obj) walk(x, cb, seen);
  } else {
    for (const v of Object.values(obj)) walk(v, cb, seen);
  }
}

function looksLikeEvent(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const keys = Object.keys(o);
  const hasEventId = keys.some(k => /^(eventId|event_id|id)$/i.test(k)) || 'eventId' in o;
  const hasTeams =
    ('homeTeamName' in o && 'awayTeamName' in o) ||
    ('homeTeam' in o && 'awayTeam' in o) ||
    ('home' in o && 'away' in o) ||
    ('competitors' in o) ||
    ('participants' in o);
  const hasKickoff = ['kickoffTime','startTime','start_time','scheduled','matchTime','time'].some(k => k in o);
  return hasEventId && (hasTeams || hasKickoff);
}

function getTeamNames(o) {
  const home =
    o.homeTeamName ?? o.homeTeam?.name ?? o.home?.name ?? o.home ??
    (Array.isArray(o.competitors) ? (o.competitors.find(x => /home/i.test(String(x?.qualifier || x?.type || '')))?.name) : undefined) ??
    (Array.isArray(o.participants) ? (o.participants[0]?.name) : undefined);
  const away =
    o.awayTeamName ?? o.awayTeam?.name ?? o.away?.name ?? o.away ??
    (Array.isArray(o.competitors) ? (o.competitors.find(x => /away/i.test(String(x?.qualifier || x?.type || '')))?.name) : undefined) ??
    (Array.isArray(o.participants) ? (o.participants[1]?.name) : undefined);
  return { home: normalizeText(home), away: normalizeText(away) };
}

function getKickoff(o) {
  return o.kickoffTime ?? o.startTime ?? o.start_time ?? o.scheduled ?? o.matchTime ?? o.time ?? null;
}

function getEventId(o) {
  return o.eventId ?? o.event_id ?? o.id ?? null;
}

function getGameId(o) {
  return o.gameId ?? o.game_id ?? o.betRadarId ?? o.sid ?? null;
}

function getTournament(o) {
  return normalizeText(
    o.tournament?.name ?? o.tournamentName ?? o.league?.name ?? o.leagueName ??
    o.category?.name ?? o.categoryName ?? ''
  );
}

function getSport(o) {
  return normalizeText(o.sport?.name ?? o.sportName ?? o.sport ?? 'Handball');
}

function extractMarkets(o) {
  const out = [];
  walk(o, node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const marketId = node.marketId ?? node.market_id ?? node.id;
    const marketDesc = node.marketDesc ?? node.marketName ?? node.name ?? node.desc;
    const outcomes = node.outcomes ?? node.options ?? node.selections;
    if (marketId != null && marketDesc && Array.isArray(outcomes) && outcomes.length) {
      out.push({
        marketId: String(marketId),
        marketDesc: normalizeText(marketDesc),
        specifier: node.specifier ?? node.specifiers ?? null,
        outcomes: outcomes.slice(0, 12).map(x => ({
          outcomeId: String(x?.outcomeId ?? x?.id ?? x?.outcome_id ?? ''),
          outcomeDesc: normalizeText(x?.outcomeDesc ?? x?.name ?? x?.desc ?? x?.label ?? ''),
          odds: String(x?.odds ?? x?.price ?? x?.value ?? ''),
          specifier: x?.specifier ?? null,
        }))
      });
    }
  });
  return out;
}

(async () => {
  if (!LOGIN_ID || !PASSWORD) {
    console.error('[Handball V2] Missing SPORTYSOCIAL_LOGIN_ID or SPORTYSOCIAL_PASSWORD');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
  });
  const page = await context.newPage();

  const captured = [];
  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('/api/ng/factsCenter/wapConfigurableEventsByOrder')) return;
    try {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json') && !ct.includes('text')) return;
      const body = await res.json();
      captured.push({ url, status: res.status(), body });
      console.log(`[Handball V2] Captured fixture endpoint: ${res.status()} ${url}`);
    } catch (e) {
      console.log(`[Handball V2] Fixture endpoint captured but JSON parse failed: ${e.message}`);
    }
  });

  try {
    console.log('[Handball V2] Opening SportyBet');
    await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Generic login strategy: click likely login button then fill visible fields.
    const loginTexts = ['Log In','Login','Sign In'];
    for (const txt of loginTexts) {
      const loc = page.getByText(txt, { exact: false }).first();
      if (await loc.count()) {
        try { await loc.click({ timeout: 3000 }); break; } catch {}
      }
    }

    const loginSelectors = [
      'input[type="tel"]','input[name*="phone" i]','input[name*="mobile" i]',
      'input[name*="user" i]','input[type="text"]'
    ];
    let loginFilled = false;
    for (const sel of loginSelectors) {
      const loc = page.locator(sel).filter({ visible: true }).first();
      if (await loc.count()) {
        try { await loc.fill(LOGIN_ID); loginFilled = true; break; } catch {}
      }
    }

    const pw = page.locator('input[type="password"]').filter({ visible: true }).first();
    if (await pw.count()) {
      try { await pw.fill(PASSWORD); } catch {}
    }

    const submitCandidates = [
      page.getByRole('button', { name: /log in|login|sign in/i }).first(),
      page.locator('button[type="submit"]').first()
    ];
    for (const btn of submitCandidates) {
      if (await btn.count()) {
        try { await btn.click({ timeout: 4000 }); break; } catch {}
      }
    }

    await page.waitForTimeout(5000);
    console.log('[Handball V2] Login attempt completed');

    console.log('[Handball V2] Opening Handball prematch page');
    await page.goto('https://www.sportybet.com/ng/m/sport/handball?sort=0', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(10000);

    await page.screenshot({ path: path.join(OUT_DIR, 'handball-v2-page.png'), fullPage: true });

    safeJsonWrite('captured-fixture-responses.json', captured.map(x => ({
      url: x.url,
      status: x.status,
      body: x.body
    })));

    const eventCandidates = [];
    const seen = new Set();

    for (const cap of captured) {
      walk(cap.body, node => {
        if (!looksLikeEvent(node)) return;
        const eventId = getEventId(node);
        const teams = getTeamNames(node);
        const kickoff = getKickoff(node);
        const key = `${eventId}|${teams.home}|${teams.away}|${kickoff}`;
        if (seen.has(key)) return;
        seen.add(key);

        const markets = extractMarkets(node);
        eventCandidates.push({
          sport: getSport(node),
          sportId: node.sportId ?? node.sport_id ?? node.sport?.id ?? null,
          eventId,
          gameId: getGameId(node),
          homeTeamName: teams.home,
          awayTeamName: teams.away,
          tournament: getTournament(node),
          kickoffTime: kickoff,
          markets
        });
      });
    }

    // Fallback: if event node has no embedded markets, attach global market-like blocks by eventId where possible.
    safeJsonWrite('handball-events-extracted.json', eventCandidates);

    console.log(`[Handball V2] Fixture endpoint responses captured: ${captured.length}`);
    console.log(`[Handball V2] Complete Handball fixture candidates extracted: ${eventCandidates.length}`);

    eventCandidates.slice(0, 10).forEach((e, i) => {
      console.log(JSON.stringify({
        n: i + 1,
        sport: e.sport,
        sportId: e.sportId,
        eventId: e.eventId,
        gameId: e.gameId,
        home: e.homeTeamName,
        away: e.awayTeamName,
        tournament: e.tournament,
        kickoffTime: e.kickoffTime,
        marketCount: e.markets.length,
        sampleMarkets: e.markets.slice(0, 3)
      }));
    });

    if (!captured.length) {
      throw new Error('NO_FIXTURE_ENDPOINT_RESPONSE_CAPTURED');
    }

    if (!eventCandidates.length) {
      throw new Error('FIXTURE_RESPONSE_CAPTURED_BUT_EVENT_SCHEMA_NOT_YET_MAPPED');
    }

    console.log('[Handball V2] SUCCESS');
  } catch (err) {
    console.error('[Handball V2] FAILED:', err.message);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'handball-v2-failure.png'), fullPage: true });
    } catch {}
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
})();
