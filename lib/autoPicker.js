// Automatic bet-slip builder.
// It prefers high-probability selections, uses controlled randomness, avoids
// multiple picks from the same event, and searches for a combined price close
// to the user's target odds.

const TEAM_ALIAS = {
  manunited: 'manchesterunited', manutd: 'manchesterunited', mancity: 'manchestercity',
  spurs: 'tottenhamhotspur', tottenham: 'tottenhamhotspur', wolves: 'wolverhamptonwanderers',
  wolverhampton: 'wolverhamptonwanderers', nottmforest: 'nottinghamforest',
  newcastle: 'newcastleunited', parissg: 'parissaintgermain', psg: 'parissaintgermain',
  internazionale: 'intermilan', atleticodemadrid: 'atleticomadrid',
  leverkusen: 'bayerleverkusen', dortmund: 'borussiadortmund', bayernmunchen: 'bayernmunich',
};

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function normTeam(name) {
  let n = String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, 'and')
    .replace(/\b(fc|cf|afc|sc|ssc|club|football|futbol|calcio)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
  return TEAM_ALIAS[n] || n;
}

function teamMatches(a, b) {
  const x = normTeam(a), y = normTeam(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x))));
}

function footballPick(r, kind) {
  if (kind === 'gg') return r.btts >= 50 ? { label: 'GG (BTTS Yes)', prob: r.btts } : { label: 'NG (BTTS No)', prob: 100 - r.btts };
  if (kind === 'ou') return r.o25 >= 50 ? { label: 'Over 2.5', prob: r.o25 } : { label: 'Under 2.5', prob: 100 - r.o25 };
  return { label: r.pick, prob: r.pickProb };
}

function findFootballSporty(r, kind, rows) {
  const fx = (rows || []).filter(x => teamMatches(r.home, x.home) && teamMatches(r.away, x.away));
  if (kind === '1x2') {
    const id = r.pick === 'Home Win' ? '1' : r.pick === 'Draw' ? '2' : '3';
    return fx.find(x => String(x.outcomeId) === id) || null;
  }
  if (kind === 'ou') {
    const over = r.o25 >= 50;
    return fx.find(x => String(x.outcomeId) === (over ? '12' : '13'))
      || fx.find(x => over ? /over/i.test(x.outcomeDesc) : /under/i.test(x.outcomeDesc)) || null;
  }
  const yes = r.btts >= 50;
  return fx.find(x => {
    const d = String(x.outcomeDesc || '').toLowerCase();
    return yes
      ? (d === 'gg' || d === 'yes' || /both.*yes|both teams.*score/.test(d))
      : (d === 'ng' || d === 'no' || /both.*no|not.*both/.test(d));
  }) || null;
}

function groupMarkets(rows) {
  const byEvent = new Map();
  for (const r of rows || []) {
    if (!byEvent.has(r.eventId)) byEvent.set(r.eventId, {
      eventId: r.eventId, home: r.home, away: r.away, tournament: r.tournament,
      kickoffUtc: r.kickoffUtc, groups: new Map(),
    });
    const ev = byEvent.get(r.eventId);
    const gk = [r.marketId, r.specifier || ''].join('|');
    if (!ev.groups.has(gk)) ev.groups.set(gk, []);
    ev.groups.get(gk).push(r);
  }

  return [...byEvent.values()].map(ev => {
    const groups = [...ev.groups.values()].filter(g => g.length >= 2);
    if (!groups.length) return null;
    let best = groups[0], bestScore = Infinity;
    for (const g of groups) {
      const inv = g.map(x => 1 / Number(x.odds)).filter(Number.isFinite);
      const sum = inv.reduce((a, b) => a + b, 0);
      if (!sum) continue;
      const probs = inv.map(x => x / sum);
      const spread = Math.max(...probs) - Math.min(...probs);
      if (spread < bestScore) { bestScore = spread; best = g; }
    }
    const inv = best.map(x => 1 / Number(x.odds));
    const sum = inv.reduce((a, b) => a + b, 0);
    const outcomes = best.map((x, i) => ({
      ...x,
      marketProb: sum ? Math.round(inv[i] / sum * 1000) / 10 : 0,
    })).sort((a, b) => b.marketProb - a.marketProb);
    return { ...ev, outcomes, topProb: outcomes[0]?.marketProb || 0, marketDesc: best[0]?.marketDesc || '' };
  }).filter(Boolean);
}

function candidateFromSelection(selection, meta, probability, probabilitySource) {
  const odds = Number(selection.odds);
  if (!Number.isFinite(odds) || odds <= 1) return null;
  return {
    eventId: String(selection.eventId), marketId: String(selection.marketId),
    outcomeId: String(selection.outcomeId), specifier: selection.specifier || null,
    odds, sport: meta.sport, home: meta.home, away: meta.away,
    tournament: meta.tournament || '', marketDesc: selection.marketDesc || meta.marketDesc || '',
    outcomeDesc: selection.outcomeDesc || meta.outcomeDesc || '',
    probability: Math.round(Number(probability) * 10) / 10,
    probabilitySource,
    kickoffUtc: selection.kickoffUtc || meta.kickoffUtc || null,
  };
}

function buildCandidates({ predictions, footballMarkets, basketballWinner, hockeyWinner, minProbability = 55, leagues = null, sportScope = 'all' }) {
  const minProb = clamp(Number(minProbability) || 0, 0, 99);
  const leagueSet = Array.isArray(leagues) && leagues.length ? new Set(leagues) : null;
  const scope = ['all', 'football', 'basketball', 'hockey'].includes(String(sportScope).toLowerCase()) ? String(sportScope).toLowerCase() : 'all';
  const candidates = [];

  if (scope === 'all' || scope === 'football') for (const r of predictions?.matches || []) {
    if (leagueSet && !leagueSet.has(r.league)) continue;
    for (const kind of ['1x2', 'gg', 'ou']) {
      const pick = footballPick(r, kind);
      if (Number(pick.prob) < minProb) continue;
      const sp = findFootballSporty(r, kind, footballMarkets?.[kind]?.rows || []);
      if (!sp) continue;
      const c = candidateFromSelection(sp, {
        sport: 'Football', home: r.home, away: r.away, tournament: r.league,
        marketDesc: sp.marketDesc, outcomeDesc: sp.outcomeDesc, kickoffUtc: r.kickoffUtc,
      }, pick.prob, 'Poisson + H2H');
      if (c) candidates.push(c);
    }
  }

  for (const [sport, payload, scopeKey] of [['Basketball', basketballWinner, 'basketball'], ['Ice Hockey', hockeyWinner, 'hockey']]) {
    if (scope !== 'all' && scope !== scopeKey) continue;
    const events = groupMarkets(payload?.rows || []);
    for (const e of events) {
      const top = e.outcomes[0];
      if (!top || Number(top.marketProb) < minProb) continue;
      const c = candidateFromSelection(top, {
        sport, home: e.home, away: e.away, tournament: e.tournament,
        marketDesc: top.marketDesc, outcomeDesc: top.outcomeDesc, kickoffUtc: e.kickoffUtc,
      }, top.marketProb, 'No-vig market probability');
      if (c) candidates.push(c);
    }
  }

  return candidates
    .filter(c => c.probability >= minProb)
    .sort((a, b) => b.probability - a.probability || a.odds - b.odds);
}

function evaluateCombo(combo, targetOdds) {
  const combinedOdds = combo.reduce((p, x) => p * x.odds, 1);
  const avgProbability = combo.reduce((s, x) => s + x.probability, 0) / Math.max(1, combo.length);
  const minProbability = combo.reduce((m, x) => Math.min(m, x.probability), 100);
  const distance = Math.abs(Math.log(Math.max(combinedOdds, 1.000001) / targetOdds));
  // Prefer reaching/exceeding the target, then closeness, then stronger picks and fewer legs.
  const belowPenalty = combinedOdds + 1e-9 < targetOdds ? 0.12 : 0;
  const score = distance + belowPenalty - (avgProbability / 100) * 0.11 - (minProbability / 100) * 0.025 + combo.length * 0.002;
  return { combinedOdds, avgProbability, minProbability, score, reachedTarget: combinedOdds >= targetOdds };
}

function weightedOrder(candidates, rng = Math.random) {
  return candidates.map(c => {
    const w = Math.pow(clamp(c.probability / 100, 0.01, 0.999), 5);
    // Weighted random priority: high probabilities dominate, but every eligible pick
    // still has a chance to appear in a generated slip.
    const key = -Math.log(Math.max(1e-12, rng())) / w;
    return { c, key };
  }).sort((a, b) => a.key - b.key).map(x => x.c);
}

function selectAutoBet(candidates, { targetOdds = 5, maxSelections = 8, trials = 1200, rng = Math.random } = {}) {
  const target = clamp(Number(targetOdds) || 5, 1.05, 2000);
  const maxLegs = clamp(parseInt(maxSelections, 10) || 8, 1, 30);
  const usable = (candidates || []).filter(c => Number.isFinite(c.odds) && c.odds > 1 && c.probability > 0);
  if (!usable.length) return { selections: [], targetOdds: target, combinedOdds: 1, reachedTarget: false, candidateCount: 0 };

  let best = null;
  const totalTrials = clamp(parseInt(trials, 10) || 1200, 50, 5000);

  // One deterministic pass ensures the strongest candidates are always considered.
  const orders = [usable.slice().sort((a, b) => b.probability - a.probability || a.odds - b.odds)];
  for (let i = 1; i < totalTrials; i++) orders.push(weightedOrder(usable, rng));

  for (const order of orders) {
    const combo = [];
    const events = new Set();
    let product = 1;

    for (const c of order) {
      if (combo.length >= maxLegs || events.has(c.eventId)) continue;
      // When several candidates are available for a fixture, keep only one outcome/event.
      combo.push(c);
      events.add(c.eventId);
      product *= c.odds;

      const evalNow = evaluateCombo(combo, target);
      if (!best || evalNow.score < best.metrics.score) best = { selections: combo.slice(), metrics: evalNow };
      if (product >= target) break;
    }
  }

  if (!best) return { selections: [], targetOdds: target, combinedOdds: 1, reachedTarget: false, candidateCount: usable.length };
  return {
    selections: best.selections,
    targetOdds: target,
    combinedOdds: Math.round(best.metrics.combinedOdds * 100) / 100,
    reachedTarget: best.metrics.reachedTarget,
    averageProbability: Math.round(best.metrics.avgProbability * 10) / 10,
    minimumProbability: Math.round(best.metrics.minProbability * 10) / 10,
    candidateCount: usable.length,
  };
}

module.exports = { buildCandidates, selectAutoBet, groupMarkets, footballPick, findFootballSporty, normTeam, teamMatches };
