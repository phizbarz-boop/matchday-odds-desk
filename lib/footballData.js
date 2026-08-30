// Thin client for the football-data.org v4 API (free tier).

const BASE = 'https://api.football-data.org/v4';

const LEAGUES = {
  PL:  { name: 'Premier League', country: 'England' },
  PD:  { name: 'La Liga', country: 'Spain' },
  SA:  { name: 'Serie A', country: 'Italy' },
  BL1: { name: 'Bundesliga', country: 'Germany' },
  FL1: { name: 'Ligue 1', country: 'France' },
  CL:  { name: 'Champions League', country: 'Europe' },
  ELC: { name: 'Championship', country: 'England' },
  DED: { name: 'Eredivisie', country: 'Netherlands' },
  PPL: { name: 'Primeira Liga', country: 'Portugal' },
};

// Free tier allows 10 requests/minute. Space calls out (~7s apart) so a full
// 9-league refresh (18 calls) never trips the limit, and retry once on 429
// in case something else nudges us over.
const MIN_INTERVAL_MS = 7000;
let lastCallAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function fdFetch(path, token, retrying = false) {
  await throttle();
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Auth-Token': token },
  });
  if (res.status === 429 && !retrying) {
    // Respect whatever wait the API asks for, then retry once.
    const body = await res.text().catch(() => '');
    const match = body.match(/Wait (\d+) seconds/i);
    const waitSec = match ? parseInt(match[1], 10) + 1 : 15;
    console.log(`Rate limited on ${path}, waiting ${waitSec}s and retrying once...`);
    await sleep(waitSec * 1000);
    lastCallAt = Date.now();
    return fdFetch(path, token, true);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`football-data.org ${path} -> ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Standings give us this-season played/goalsFor/goalsAgainst per team in one call.
async function getStandings(code, token) {
  const data = await fdFetch(`/competitions/${code}/standings`, token);
  const table = (data.standings || []).find(s => s.type === 'TOTAL')?.table || [];
  const teams = {};
  for (const row of table) {
    teams[row.team.name] = {
      id: row.team.id,
      played: row.playedGames || 0,
      gf: row.goalsFor || 0,
      ga: row.goalsAgainst || 0,
    };
  }
  return teams;
}

// Upcoming scheduled matches in a date window.
async function getUpcomingMatches(code, token, dateFrom, dateTo) {
  const data = await fdFetch(
    `/competitions/${code}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=SCHEDULED`,
    token
  );
  return (data.matches || []).map(m => ({
    id: m.id,
    utcDate: m.utcDate,
    homeTeam: m.homeTeam.name,
    awayTeam: m.awayTeam.name,
    matchday: m.matchday,
  }));
}

module.exports = { LEAGUES, getStandings, getUpcomingMatches };
