// Poisson goal-expectancy model shared by the refresh job and server-side tests.

function poissonPmf(k, lam) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return Math.exp(-lam) * Math.pow(lam, k) / fact;
}

function scoreMatrix(lamHome, lamAway, maxGoals = 8) {
  const m = [];
  for (let h = 0; h <= maxGoals; h++) {
    const row = [];
    for (let a = 0; a <= maxGoals; a++) {
      row.push(poissonPmf(h, lamHome) * poissonPmf(a, lamAway));
    }
    m.push(row);
  }
  return m;
}

function oneUpProbs(matrix) {
  // Probability a side leads by at least one goal at ANY point in regulation.
  // Conditional on a final h-a score, all goal-orderings are equally likely under
  // independent Poisson scoring processes. By the ballot/reflection principle:
  // if home finishes ahead it must have led; otherwise P(home ever led)=h/(a+1).
  // Away is symmetric. This captures 1UP correctly even when the selected team
  // later draws or loses after taking the lead.
  let home = 0, away = 0, mass = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      mass += p;
      const ph = h > a ? 1 : (a >= 0 ? h / (a + 1) : 0);
      const pa = a > h ? 1 : (h >= 0 ? a / (h + 1) : 0);
      home += p * ph;
      away += p * pa;
    }
  }
  if (mass > 0) { home /= mass; away /= mass; }
  return { oneUpHome: home, oneUpAway: away };
}

function outcomeProbs(matrix) {
  let homeWin = 0, draw = 0, awayWin = 0, bttsYes = 0, over15 = 0, over25 = 0, under45 = 0;
  const scores = [];
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      scores.push({ h, a, p });
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
      if (h > 0 && a > 0) bttsYes += p;
      if (h + a > 1) over15 += p;
      if (h + a > 2) over25 += p;
      if (h + a < 5) under45 += p;
    }
  }
  scores.sort((x, y) => y.p - x.p);
  return {
    homeWin, draw, awayWin,
    bttsYes, bttsNo: 1 - bttsYes,
    over15, under15: 1 - over15,
    over25, under25: 1 - over25,
    under45, over45: 1 - under45,
    topScore: scores[0],
  };
}

// Bayesian shrinkage: blend a team's own-season rate with the league-average rate,
// weighted by how many games they've played (k = "games worth" of trust in the prior).
function blendedRate(goals, played, leagueAvg, k = 6) {
  return (goals + k * leagueAvg) / (played + k);
}

function teamStrength({ gf, ga, played }, leagueAvgGf, leagueAvgGa, k = 6) {
  const gfPg = blendedRate(gf, played, leagueAvgGf, k);
  const gaPg = blendedRate(ga, played, leagueAvgGa, k);
  return {
    attack: gfPg / leagueAvgGf,
    defense: gaPg / leagueAvgGa,
  };
}

function predictMatch(homeStrength, awayStrength, leagueHomeAvg, leagueAwayAvg, homeAdv = 1.15) {
  const lamHome = leagueHomeAvg * homeStrength.attack * awayStrength.defense * homeAdv;
  const lamAway = leagueAwayAvg * awayStrength.attack * homeStrength.defense;
  const matrix = scoreMatrix(lamHome, lamAway);
  const probs = outcomeProbs(matrix);
  const oneUp = oneUpProbs(matrix);
  return { ...probs, ...oneUp, lamHome, lamAway };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// H2H is intentionally a modifier, not the whole model. Recent direct meetings are
// weighted more heavily, but the maximum influence is capped so a handful of old
// games cannot overwhelm current-season team strength.
function summarizeH2H(matches, currentHome, currentAway, maxMeetings = 8, decay = 0.82) {
  const relevant = (matches || [])
    .filter(m => {
      const same = m.homeTeam === currentHome && m.awayTeam === currentAway;
      const reverse = m.homeTeam === currentAway && m.awayTeam === currentHome;
      return (same || reverse) && Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals);
    })
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, maxMeetings);

  if (!relevant.length) {
    return {
      meetings: 0, homeWins: 0, draws: 0, awayWins: 0,
      bttsRate: null, over15Rate: null, over25Rate: null, under45Rate: null, weightedTotal: 0,
      samples: [],
    };
  }

  let wTotal = 0, hWins = 0, draws = 0, aWins = 0, btts = 0, over15 = 0, over25 = 0, under45 = 0;
  const samples = [];
  relevant.forEach((m, idx) => {
    const w = Math.pow(decay, idx);
    const currentHomeGoals = m.homeTeam === currentHome ? m.homeGoals : m.awayGoals;
    const currentAwayGoals = m.awayTeam === currentAway ? m.awayGoals : m.homeGoals;
    wTotal += w;
    if (currentHomeGoals > currentAwayGoals) hWins += w;
    else if (currentHomeGoals === currentAwayGoals) draws += w;
    else aWins += w;
    if (currentHomeGoals > 0 && currentAwayGoals > 0) btts += w;
    if (currentHomeGoals + currentAwayGoals > 1) over15 += w;
    if (currentHomeGoals + currentAwayGoals > 2) over25 += w;
    if (currentHomeGoals + currentAwayGoals < 5) under45 += w;
    samples.push({
      utcDate: m.utcDate,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      homeGoals: m.homeGoals,
      awayGoals: m.awayGoals,
    });
  });

  return {
    meetings: relevant.length,
    homeWins: hWins / wTotal,
    draws: draws / wTotal,
    awayWins: aWins / wTotal,
    bttsRate: btts / wTotal,
    over15Rate: over15 / wTotal,
    over25Rate: over25 / wTotal,
    under45Rate: under45 / wTotal,
    weightedTotal: wTotal,
    samples,
  };
}

function blendPredictionWithH2H(base, h2h, maxWeight = 0.18) {
  if (!h2h || !h2h.meetings) {
    return { ...base, h2hWeight: 0, h2hMeetings: 0 };
  }

  // 3% per meeting up to the configured cap. Five meetings = 15% H2H influence.
  const weight = clamp(h2h.meetings * 0.03, 0, clamp(maxWeight, 0, 0.35));
  const keep = 1 - weight;

  const homeWin = base.homeWin * keep + h2h.homeWins * weight;
  const draw = base.draw * keep + h2h.draws * weight;
  const awayWin = base.awayWin * keep + h2h.awayWins * weight;
  const resultTotal = homeWin + draw + awayWin || 1;

  const bttsYes = base.bttsYes * keep + h2h.bttsRate * weight;
  const over15 = base.over15 * keep + h2h.over15Rate * weight;
  const over25 = base.over25 * keep + h2h.over25Rate * weight;
  const under45 = base.under45 * keep + h2h.under45Rate * weight;

  return {
    ...base,
    homeWin: homeWin / resultTotal,
    draw: draw / resultTotal,
    awayWin: awayWin / resultTotal,
    bttsYes,
    bttsNo: 1 - bttsYes,
    over15,
    under15: 1 - over15,
    over25,
    under25: 1 - over25,
    under45,
    over45: 1 - under45,
    h2hWeight: weight,
    h2hMeetings: h2h.meetings,
  };
}

module.exports = {
  poissonPmf,
  scoreMatrix,
  outcomeProbs,
  oneUpProbs,
  teamStrength,
  predictMatch,
  blendedRate,
  summarizeH2H,
  blendPredictionWithH2H,
};
