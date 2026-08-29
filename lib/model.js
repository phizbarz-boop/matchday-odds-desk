// Poisson goal-expectancy model shared by the refresh job and (optionally) the server.

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

function outcomeProbs(matrix) {
  let homeWin = 0, draw = 0, awayWin = 0, bttsYes = 0, over25 = 0;
  const scores = [];
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      scores.push({ h, a, p });
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
      if (h > 0 && a > 0) bttsYes += p;
      if (h + a > 2) over25 += p;
    }
  }
  scores.sort((x, y) => y.p - x.p);
  return {
    homeWin, draw, awayWin,
    bttsYes, bttsNo: 1 - bttsYes,
    over25, under25: 1 - over25,
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
  return { ...probs, lamHome, lamAway };
}

module.exports = { poissonPmf, scoreMatrix, outcomeProbs, teamStrength, predictMatch, blendedRate };
