// Daily job: pull fixtures + current-season form from football-data.org for the
// configured leagues, compute probabilities with the Poisson model, and store the
// result for the web service to serve. Run manually with `node jobs/refresh.js`.

const fs = require('fs');
const path = require('path');
const { LEAGUES, getStandings, getUpcomingMatches } = require('../lib/footballData');
const { teamStrength, predictMatch } = require('../lib/model');

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const LEAGUE_CODES = (process.env.LEAGUES || 'PL,PD,SA,BL1,FL1').split(',').map(s => s.trim());
const DAYS_AHEAD = parseInt(process.env.DAYS_AHEAD || '4', 10);
const DATA_FILE = path.join(__dirname, '..', 'data', 'predictions.json');

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function pickLabel(p) {
  if (p.homeWin >= p.draw && p.homeWin >= p.awayWin) return 'Home Win';
  if (p.awayWin >= p.draw) return 'Away Win';
  return 'Draw';
}

async function buildLeague(code) {
  const meta = LEAGUES[code];
  if (!meta) throw new Error(`Unknown league code ${code}`);

  const standings = await getStandings(code, TOKEN);
  const teamNames = Object.keys(standings);
  if (teamNames.length === 0) return [];

  // League average goals-per-team-per-game, used as the shrinkage prior and base rate.
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

  const results = [];
  for (const fx of fixtures) {
    const home = strengths[fx.homeTeam];
    const away = strengths[fx.awayTeam];
    if (!home || !away) continue; // promoted/new team with no standings row yet
    const probs = predictMatch(home, away, leagueAvg, leagueAvg, 1.15);
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
      o25: Math.round(probs.over25 * 100),
      score: `${probs.topScore.h}-${probs.topScore.a}`,
      scoreP: Math.round(probs.topScore.p * 100),
      pick: pickLabel(probs),
      pickProb: Math.round(Math.max(probs.homeWin, probs.draw, probs.awayWin) * 100),
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
  console.log('LEAGUES env raw =', JSON.stringify(process.env.LEAGUES));
  console.log('LEAGUE_CODES =', JSON.stringify(LEAGUE_CODES));
  if (!TOKEN) {
    console.error('Missing FOOTBALL_DATA_TOKEN env var.');
    process.exit(1);
  }
  let all = [];
  for (const code of LEAGUE_CODES) {
    console.log('Attempting', code);
    try {
      const rows = await buildLeague(code);
      all = all.concat(rows);
      console.log(`${code}: ${rows.length} fixtures`);
    } catch (err) {
      console.log(`Failed to build ${code}:`, err.message);
    }
  }
  all.sort((x, y) => y.pickProb - x.pickProb);
  await storeResult({ generatedAt: new Date().toISOString(), matches: all });
  console.log(`Done. ${all.length} total fixtures.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
