// Automatic bet-slip builder.
// Version 2: probability + value engine.
// Ranks selections by model probability, bookmaker-implied probability,
// model/pricing edge, market reliability and expected value while keeping
// one selection per event.

const TEAM_ALIAS = {
  manunited: 'manchesterunited', manutd: 'manchesterunited', mancity: 'manchestercity',
  spurs: 'tottenhamhotspur', tottenham: 'tottenhamhotspur', wolves: 'wolverhamptonwanderers',
  wolverhampton: 'wolverhamptonwanderers', nottmforest: 'nottinghamforest',
  newcastle: 'newcastleunited', parissg: 'parissaintgermain', psg: 'parissaintgermain',
  internazionale: 'intermilan', atleticodemadrid: 'atleticomadrid',
  leverkusen: 'bayerleverkusen', dortmund: 'borussiadortmund', bayernmunchen: 'bayernmunich',
};

const MARKET_RELIABILITY = {
  'Football:1x2': 0.88,
  'Football:gg': 0.82,
  'Football:ou': 0.85,
  'Basketball:winner': 0.86,
  'Ice Hockey:winner': 0.82,
};

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function round1(n) { return Math.round(Number(n) * 10) / 10; }
function round2(n) { return Math.round(Number(n) * 100) / 100; }

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
      marketProb: sum ? round1(inv[i] / sum * 100) : 0,
    })).sort((a, b) => b.marketProb - a.marketProb);
    return { ...ev, outcomes, topProb: outcomes[0]?.marketProb || 0, marketDesc: best[0]?.marketDesc || '' };
  }).filter(Boolean);
}

function enrichValueMetrics({ odds, probability, marketReliability = 0.8, probabilitySource = '' }) {
  const p = clamp(Number(probability) || 0, 0, 100);
  const o = Number(odds);
  const impliedProbability = o > 1 ? 100 / o : 100;
  const edge = p - impliedProbability;
  const expectedValuePct = ((p / 100) * o - 1) * 100;
  const edgeScore = clamp(50 + edge * 4, 0, 100);
  const qualityScore = clamp(
    p * 0.55 + edgeScore * 0.25 + (marketReliability * 100) * 0.20,
    0,
    100
  );
  return {
    impliedProbability: round1(impliedProbability),
    edge: round1(edge),
    expectedValuePct: round1(expectedValuePct),
    marketReliability: round1(marketReliability * 100),
    qualityScore: round1(qualityScore),
    edgeType: /No-vig/i.test(probabilitySource) ? 'market-adjusted' : 'model-vs-price',
  };
}

function candidateFromSelection(selection, meta, probability, probabilitySource, marketKey) {
  const odds = Number(selection.odds);
  if (!Number.isFinite(odds) || odds <= 1) return null;
  const reliability = MARKET_RELIABILITY[marketKey] || 0.80;
  const metrics = enrichValueMetrics({ odds, probability, marketReliability: reliability, probabilitySource });
  return {
    eventId: String(selection.eventId), marketId: String(selection.marketId),
    outcomeId: String(selection.outcomeId), specifier: selection.specifier || null,
    odds, sport: meta.sport, home: meta.home, away: meta.away,
    tournament: meta.tournament || '', marketDesc: selection.marketDesc || meta.marketDesc || '',
    outcomeDesc: selection.outcomeDesc || meta.outcomeDesc || '',
    probability: round1(probability),
    probabilitySource,
    marketKind: marketKey.split(':')[1] || '',
    kickoffUtc: selection.kickoffUtc || meta.kickoffUtc || null,
    ...metrics,
  };
}

function buildCandidates({ predictions, footballMarkets, basketballWinner, hockeyWinner, minProbability = 55, minEdge = 0, leagues = null, sportScope = 'all' }) {
  const minProb = clamp(Number(minProbability) || 0, 0, 99);
  const edgeFloor = clamp(Number(minEdge) || 0, -25, 50);
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
      }, pick.prob, 'Poisson + H2H', `Football:${kind}`);
      if (c && c.edge >= edgeFloor) candidates.push(c);
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
      }, top.marketProb, 'No-vig market probability', `${sport}:winner`);
      // For sports without an independent model, edge is a pricing/de-margin metric,
      // not a proven predictive edge. We still expose it, but do not hard-filter it.
      if (c) candidates.push(c);
    }
  }

  return candidates
    .filter(c => c.probability >= minProb)
    .sort((a, b) => b.qualityScore - a.qualityScore || b.probability - a.probability || a.odds - b.odds);
}

function evaluateCombo(combo, targetOdds) {
  const combinedOdds = combo.reduce((p, x) => p * x.odds, 1);
  const avgProbability = combo.reduce((s, x) => s + x.probability, 0) / Math.max(1, combo.length);
  const minProbability = combo.reduce((m, x) => Math.min(m, x.probability), 100);
  const avgEdge = combo.reduce((s, x) => s + x.edge, 0) / Math.max(1, combo.length);
  const avgQualityScore = combo.reduce((s, x) => s + x.qualityScore, 0) / Math.max(1, combo.length);
  const estimatedSlipProbability = combo.reduce((p, x) => p * clamp(x.probability / 100, 0, 1), 1) * 100;
  const fairSlipOdds = estimatedSlipProbability > 0 ? 100 / estimatedSlipProbability : null;
  const estimatedSlipEVPct = ((estimatedSlipProbability / 100) * combinedOdds - 1) * 100;
  const distance = Math.abs(Math.log(Math.max(combinedOdds, 1.000001) / targetOdds));
  const belowPenalty = combinedOdds + 1e-9 < targetOdds ? 0.12 : 0;
  // Main optimization: target closeness + quality/value, not raw probability alone.
  const score = distance + belowPenalty
    - (avgQualityScore / 100) * 0.16
    - clamp(avgEdge, -20, 20) * 0.0025
    + combo.length * 0.0015;
  return {
    combinedOdds, avgProbability, minProbability, avgEdge, avgQualityScore,
    estimatedSlipProbability, fairSlipOdds, estimatedSlipEVPct,
    score, reachedTarget: combinedOdds >= targetOdds,
  };
}

function weightedOrder(candidates, rng = Math.random) {
  return candidates.map(c => {
    const q = clamp(c.qualityScore / 100, 0.01, 0.999);
    const p = clamp(c.probability / 100, 0.01, 0.999);
    const w = Math.pow(q * 0.65 + p * 0.35, 5);
    const key = -Math.log(Math.max(1e-12, rng())) / w;
    return { c, key };
  }).sort((a, b) => a.key - b.key).map(x => x.c);
}

function selectAutoBet(candidates, { targetOdds = 5, maxSelections = 8, trials = 1200, minQualityScore = 0, requirePositiveEV = false, rng = Math.random } = {}) {
  const target = clamp(Number(targetOdds) || 5, 1.05, 2000);
  const maxLegs = clamp(parseInt(maxSelections, 10) || 8, 1, 30);
  const qualityFloor = clamp(Number(minQualityScore) || 0, 0, 100);
  const usable = (candidates || []).filter(c => Number.isFinite(c.odds) && c.odds > 1 && c.probability > 0 && c.qualityScore >= qualityFloor && (!requirePositiveEV || c.expectedValuePct > 0));
  if (!usable.length) return { selections: [], targetOdds: target, combinedOdds: 1, reachedTarget: false, candidateCount: 0 };

  let best = null;
  const totalTrials = clamp(parseInt(trials, 10) || 1200, 50, 5000);
  const orders = [usable.slice().sort((a, b) => b.qualityScore - a.qualityScore || b.probability - a.probability)];
  for (let i = 1; i < totalTrials; i++) orders.push(weightedOrder(usable, rng));

  for (const order of orders) {
    const combo = [];
    const events = new Set();
    let product = 1;
    for (const c of order) {
      if (combo.length >= maxLegs || events.has(c.eventId)) continue;
      combo.push(c);
      events.add(c.eventId);
      product *= c.odds;
      const evalNow = evaluateCombo(combo, target);
      if (!best || evalNow.score < best.metrics.score) best = { selections: combo.slice(), metrics: evalNow };
      if (product >= target) break;
    }
  }

  if (!best) return { selections: [], targetOdds: target, combinedOdds: 1, reachedTarget: false, candidateCount: usable.length };
  const m = best.metrics;
  return {
    selections: best.selections,
    targetOdds: target,
    combinedOdds: round2(m.combinedOdds),
    reachedTarget: m.reachedTarget,
    averageProbability: round1(m.avgProbability),
    minimumProbability: round1(m.minProbability),
    averageEdge: round1(m.avgEdge),
    averageQualityScore: round1(m.avgQualityScore),
    estimatedSlipProbability: Math.round(m.estimatedSlipProbability * 1000) / 1000,
    fairSlipOdds: m.fairSlipOdds ? round2(m.fairSlipOdds) : null,
    estimatedSlipEVPct: round1(m.estimatedSlipEVPct),
    candidateCount: usable.length,
  };
}

module.exports = { buildCandidates, selectAutoBet, groupMarkets, footballPick, findFootballSporty, normTeam, teamMatches, enrichValueMetrics, MARKET_RELIABILITY };
