// Daily job: pull fixtures + current-season form from football-data.org for the
// configured leagues, compute Poisson probabilities, blend a capped H2H signal,
// and store the result for the web service to serve.

const fs = require('fs');
const path = require('path');
const { LEAGUES, getStandings, getUpcomingMatches, getFinishedMatches } = require('../lib/footballData');
const { teamStrength, predictMatch, summarizeH2H, blendPredictionWithH2H } = require('../lib/model');

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const LEAGUE_CODES = (process.env.LEAGUES || 'PL,PD,SA,BL1,FL1').split(',').map(s => s.trim());
const DAYS_AHEAD = parseInt(process.env.DAYS_AHEAD || '4', 10);
const H2H_PREVIOUS_SEASONS = Math.max(0, Math.min(3, parseInt(process.env.H2H_PREVIOUS_SEASONS || '1', 10)));
const H2H_MAX_WEIGHT = Math.max(0, Math.min(0.35, parseFloat(process.env.H2H_MAX_WEIGHT || '0.18')));
const H2H_MAX_MEETINGS = Math.max(1, Math.min(20, parseInt(process.env.H2H_MAX_MEETINGS || '8', 10)));
const DATA_FILE = path.join(__dirname, '..', 'data', 'predictions.json');

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function pickLabel(p) {
  if (p.homeWin >= p.draw && p.homeWin >= p.awayWin) return 'Home Win';
  if (p.awayWin >= p.draw) return 'Away Win';
  return 'Draw';
}

// European football seasons are represented by their starting year.
function activeSeasonStartYear(now = new Date()) {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

async function loadH2HHistory(code) {
  const all = [];
  // Current-season completed games are useful for repeat cup/league meetings.
  try {
    all.push(...await getFinishedMatches(code, TOKEN));
  } catch (err) {
    console.warn(`${code}: current-season H2H history unavailable: ${err.message}`);
  }

  const currentStart = activeSeasonStartYear();
  for (let i = 1; i <= H2H_PREVIOUS_SEASONS; i++) {
    try {
      all.push(...await getFinishedMatches(code, TOKEN, currentStart - i));
    } catch (err) {
      // Historical seasons can be restricted by football-data.org plan. The model
      // remains valid without them, so degrade gracefully rather than failing refresh.
      console.warn(`${code}: season ${currentStart - i} H2H history unavailable: ${err.message}`);
      if (err.status === 403) break;
    }
  }

  const seen = new Set();
  return all.filter(m => {
    if (!m || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

async function buildLeague(code) {
  const meta = LEAGUES[code];
  if (!meta) throw new Error(`Unknown league code ${code}`);

  const standings = await getStandings(code, TOKEN);
  const teamNames = Object.keys(standings);
  if (teamNames.length === 0) return [];

  let totalGoals = 0, totalPlayed = 0;
  for (const t of teamNames) {
    totalGoals += standings[t].gf;
    totalPlayed += standings[t].played;
  }
  const leagueAvg = totalPlayed > 0 ? totalGoals / totalPlayed : 1.35;

  const strengths = {};
  for (const name of teamNames) {
    strengths[name] = teamStrength(standings[name], leagueAvg, leagueAvg);
  }

  const today = new Date();
  const from = fmtDate(today);
  const toDate = new Date(today);
  toDate.setDate(toDate.getDate() + DAYS_AHEAD);
  const to = fmtDate(toDate);

  const fixtures = await getUpcomingMatches(code, TOKEN, from, to);
  const history = await loadH2HHistory(code);

  const results = [];
  for (const fx of fixtures) {
    const home = strengths[fx.homeTeam];
    const away = strengths[fx.awayTeam];
    if (!home || !away) continue;

    const base = predictMatch(home, away, leagueAvg, leagueAvg, 1.15);
    const h2h = summarizeH2H(history, fx.homeTeam, fx.awayTeam, H2H_MAX_MEETINGS);
    const probs = blendPredictionWithH2H(base, h2h, H2H_MAX_WEIGHT);

    results.push({
      league: meta.name,
      leagueCode: code,
      home: fx.homeTeam,
      away: fx.awayTeam,
      kickoffUtc: fx.utcDate,
      h: Math.round(probs.homeWin * 100),
      d: Math.round(probs.draw * 100),
      a: Math.round(probs.awayWin * 100),
      btts: Math.round(probs.bttsYes * 100),
      o15: Math.round(probs.over15 * 100),
      u45: Math.round(probs.under45 * 100),
      o25: Math.round(probs.over25 * 100),
      score: `${probs.topScore.h}-${probs.topScore.a}`,
      scoreP: Math.round(probs.topScore.p * 100),
      pick: pickLabel(probs),
      pickProb: Math.round(Math.max(probs.homeWin, probs.draw, probs.awayWin) * 100),
      base: {
        h: Math.round(base.homeWin * 100),
        d: Math.round(base.draw * 100),
        a: Math.round(base.awayWin * 100),
        btts: Math.round(base.bttsYes * 100),
        o15: Math.round(base.over15 * 100),
        u45: Math.round(base.under45 * 100),
        o25: Math.round(base.over25 * 100),
      },
      h2h: {
        meetings: h2h.meetings,
        influencePct: Math.round((probs.h2hWeight || 0) * 100),
        homeWinPct: h2h.meetings ? Math.round(h2h.homeWins * 100) : null,
        drawPct: h2h.meetings ? Math.round(h2h.draws * 100) : null,
        awayWinPct: h2h.meetings ? Math.round(h2h.awayWins * 100) : null,
        bttsPct: h2h.meetings ? Math.round(h2h.bttsRate * 100) : null,
        over15Pct: h2h.meetings ? Math.round(h2h.over15Rate * 100) : null,
        under45Pct: h2h.meetings ? Math.round(h2h.under45Rate * 100) : null,
        over25Pct: h2h.meetings ? Math.round(h2h.over25Rate * 100) : null,
        recent: h2h.samples.slice(0, 5),
      },
    });
  }
  return results;
}

async function storeResult(payload) {
  if (process.env.REDIS_URL) {
    const { createClient } = require('redis');
    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();
    await client.set('predictions:latest', JSON.stringify(payload));
    await client.quit();
    console.log('Wrote predictions to Redis key "predictions:latest"');
  } else {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
    console.log(`Wrote predictions to ${DATA_FILE} (no REDIS_URL set)`);
  }
}

async function main() {
  if (!TOKEN) {
    console.error('Missing FOOTBALL_DATA_TOKEN env var.');
    process.exit(1);
  }
  let all = [];
  for (const code of LEAGUE_CODES) {
    try {
      const rows = await buildLeague(code);
      all = all.concat(rows);
      console.log(`${code}: ${rows.length} fixtures`);
    } catch (err) {
      console.error(`Failed to build ${code}:`, err.message);
    }
  }
  all.sort((x, y) => y.pickProb - x.pickProb);
  await storeResult({
    generatedAt: new Date().toISOString(),
    model: {
      name: 'Poisson + H2H',
      h2hMaxWeight: H2H_MAX_WEIGHT,
      h2hPreviousSeasons: H2H_PREVIOUS_SEASONS,
      h2hMaxMeetings: H2H_MAX_MEETINGS,
    },
    matches: all,
  });
  console.log(`Done. ${all.length} total fixtures.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
