
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


function watYearForDayMonth(day, month) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const get = type => Number(parts.find(x => x.type === type)?.value || 0);
  const nowYear = get('year');
  const nowMonth = get('month');
  const nowDay = get('day');

  let year = nowYear;
  // Around year-end SportyBet can show January fixtures while current date is December.
  if (nowMonth === 12 && month === 1) year += 1;
  // And the reverse can occur when the page still shows late-December events.
  if (nowMonth === 1 && month === 12) year -= 1;

  return year;
}

function toWatIso(day, month, timeText) {
  const m = String(timeText || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const year = watYearForDayMonth(day, month);
  const hh = String(Number(m[1])).padStart(2, '0');
  const mm = String(Number(m[2])).padStart(2, '0');
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T${hh}:${mm}:00+01:00`;
}

function parseHandballPageFixtureMetadata(bodyText) {
  const lines = String(bodyText || '')
    .split(/\r?\n/)
    .map(normalizeText)
    .filter(Boolean);

  const byGameId = new Map();
  let currentDay = null;
  let currentMonth = null;

  for (let i = 0; i < lines.length; i++) {
    const dateMatch = lines[i].match(/^(\d{1,2})\/(\d{1,2})(?:\s|$)/);
    if (dateMatch) {
      currentDay = Number(dateMatch[1]);
      currentMonth = Number(dateMatch[2]);
      continue;
    }

    if (!currentDay || !currentMonth) continue;

    const timeMatch = lines[i].match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) continue;

    const idLine = lines[i + 1] || '';
    const idMatch = idLine.match(/^ID\s+(\d+)$/i);
    if (!idMatch) continue;

    const gameId = idMatch[1];
    const tournament = lines[i + 2] || '';
    const homeTeamName = lines[i + 3] || '';
    const awayTeamName = lines[i + 4] || '';

    // Avoid swallowing page-navigation labels as fixtures.
    if (!tournament || !homeTeamName || !awayTeamName) continue;
    if (/^(all live|matches|outrights|daily|league|odds|sort)$/i.test(tournament)) continue;

    byGameId.set(gameId, {
      gameId,
      tournament,
      homeTeamName,
      awayTeamName,
      kickoffTime: toWatIso(currentDay, currentMonth, lines[i]),
      dateText: `${String(currentDay).padStart(2,'0')}/${String(currentMonth).padStart(2,'0')}`,
      timeText: lines[i]
    });
  }

  return byGameId;
}

(async () => {
  if (!LOGIN_ID || !PASSWORD) {
    console.error('[Handball V4] Missing SPORTYSOCIAL_LOGIN_ID or SPORTYSOCIAL_PASSWORD');
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
      console.log(`[Handball V4] Captured fixture endpoint: ${res.status()} ${url}`);
    } catch (e) {
      console.log(`[Handball V4] Fixture endpoint captured but JSON parse failed: ${e.message}`);
    }
  });

  try {
    console.log('[Handball V4] Opening SportyBet');
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
    console.log('[Handball V4] Login attempt completed');

    console.log('[Handball V4] Opening Handball prematch page');
    await page.goto('https://www.sportybet.com/ng/m/sport/handball?sort=0', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(10000);

    const pageFixtureMetadata = new Map();
    let stableRounds = 0;
    let previousCount = 0;

    for (let round = 0; round < 30; round++) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const parsed = parseHandballPageFixtureMetadata(bodyText);
      for (const [gameId, row] of parsed.entries()) {
        pageFixtureMetadata.set(gameId, row);
      }

      console.log(`[Handball V4] Metadata scan ${round + 1}: ${pageFixtureMetadata.size} unique fixture rows`);

      if (pageFixtureMetadata.size === previousCount) stableRounds += 1;
      else stableRounds = 0;

      previousCount = pageFixtureMetadata.size;

      if (stableRounds >= 3) break;

      await page.evaluate(() => {
        window.scrollBy(0, Math.max(window.innerHeight * 0.9, 700));
      });
      await page.waitForTimeout(1200);
    }

    // Final pass at the bottom in case virtualization swaps in the last rows.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    const finalBodyText = await page.locator('body').innerText().catch(() => '');
    const finalParsed = parseHandballPageFixtureMetadata(finalBodyText);
    for (const [gameId, row] of finalParsed.entries()) {
      pageFixtureMetadata.set(gameId, row);
    }

    console.log(`[Handball V4] Total page fixture metadata rows parsed: ${pageFixtureMetadata.size}`);

    await page.screenshot({ path: path.join(OUT_DIR, 'handball-v4-page.png'), fullPage: true });

    safeJsonWrite('handball-page-fixture-metadata.json', Array.from(pageFixtureMetadata.values()));
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
        const gameId = getGameId(node);
        let pageMeta = gameId != null ? pageFixtureMetadata.get(String(gameId)) : null;

        if (!pageMeta) {
          const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const nh = norm(teams.home);
          const na = norm(teams.away);
          if (nh && na) {
            pageMeta = Array.from(pageFixtureMetadata.values()).find(row =>
              norm(row.homeTeamName) === nh && norm(row.awayTeamName) === na
            ) || null;
          }
        }

        eventCandidates.push({
          sport: getSport(node),
          sportId: node.sportId ?? node.sport_id ?? node.sport?.id ?? null,
          eventId,
          gameId,
          homeTeamName: teams.home || pageMeta?.homeTeamName || '',
          awayTeamName: teams.away || pageMeta?.awayTeamName || '',
          tournament: getTournament(node) || pageMeta?.tournament || '',
          kickoffTime: kickoff || pageMeta?.kickoffTime || null,
          kickoffSource: kickoff ? 'network' : (pageMeta?.kickoffTime ? 'page_text' : null),
          tournamentSource: getTournament(node) ? 'network' : (pageMeta?.tournament ? 'page_text' : null),
          markets
        });
      });
    }

    // Fallback: if event node has no embedded markets, attach global market-like blocks by eventId where possible.
    safeJsonWrite('handball-events-extracted.json', eventCandidates);

    const withKickoff = eventCandidates.filter(x => x.kickoffTime).length;
    const withTournament = eventCandidates.filter(x => x.tournament).length;
    const complete = eventCandidates.filter(x => x.kickoffTime && x.tournament && x.homeTeamName && x.awayTeamName).length;

    console.log(`[Handball V4] Fixture endpoint responses captured: ${captured.length}`);
    console.log(`[Handball V4] Handball fixture candidates extracted: ${eventCandidates.length}`);
    console.log(`[Handball V4] With kickoff: ${withKickoff}/${eventCandidates.length}`);
    console.log(`[Handball V4] With tournament: ${withTournament}/${eventCandidates.length}`);
    console.log(`[Handball V4] Complete metadata: ${complete}/${eventCandidates.length}`);

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
        kickoffSource: e.kickoffSource,
        tournamentSource: e.tournamentSource,
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

    if (!eventCandidates.some(x => x.kickoffTime && x.tournament)) {
      throw new Error('FIXTURES_FOUND_BUT_KICKOFF_OR_TOURNAMENT_NOT_MAPPED');
    }

    const completenessRatio = eventCandidates.length ? complete / eventCandidates.length : 0;
    if (completenessRatio < 0.8) {
      throw new Error(`HANDALL_METADATA_INCOMPLETE:${complete}/${eventCandidates.length}`);
    }

    console.log('[Handball V4] SUCCESS');
  } catch (err) {
    console.error('[Handball V4] FAILED:', err.message);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'handball-v2-failure.png'), fullPage: true });
    } catch {}
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
})();
