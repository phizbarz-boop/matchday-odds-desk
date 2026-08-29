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

async function fdFetch(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Auth-Token': token },
  });
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
