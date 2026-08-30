// Automatic bet-slip builder.
// Version 3: settlement-aware football market engine.
// Football markets: 1X2, GG/NG, Double Chance, Draw No Bet,
// Over 1.5, Under 4.5, and Asian Handicap +0 / +0.25 / -0.25.
// Over/Under 2.5 is intentionally excluded from automatic selection.

const TEAM_ALIAS = {
  manunited: 'manchesterunited', manutd: 'manchesterunited', mancity: 'manchestercity',
  spurs: 'tottenhamhotspur', tottenham: 'tottenhamhotspur', wolves: 'wolverhamptonwanderers',
  wolverhampton: 'wolverhamptonwanderers', nottmforest: 'nottinghamforest',
  newcastle: 'newcastleunited', parissg: 'parissaintgermain', psg: 'parissaintgermain',
  internazionale: 'intermilan', atleticodemadrid: 'atleticomadrid',
  leverkusen: 'bayerleverkusen', dortmund: 'borussiadortmund', bayernmunchen: 'bayernmunich',
};

const MARKET_RELIABILITY = {
  'Football:1x2': 0.86,
  'Football:gg': 0.82,
  'Football:dc': 0.91,
  'Football:dnb': 0.90,
  'Football:ou15': 0.91,
  'Football:ou45': 0.91,
  'Football:ah': 0.90,
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

function resultProbs(r) {
  return { home: Number(r.h || 0) / 100, draw: Number(r.d || 0) / 100, away: Number(r.a || 0) / 100 };
}

function sideFromOutcome(row, r) {
  const d = String(row?.outcomeDesc || '').toLowerCase();
  const id = String(row?.outcomeId || '');
  if (/home|^1$/.test(d) || ['1','4'].includes(id) || teamMatches(row?.outcomeDesc, r.home)) return 'home';
  if (/away|^2$/.test(d) || ['2','3','5'].includes(id) || teamMatches(row?.outcomeDesc, r.away)) return 'away';
  return null;
}

function parseHomeHandicap(specifier) {
  const m = String(specifier || '').match(/hcp\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}

function selectedHandicap(row, r) {
  const homeLine = parseHomeHandicap(row?.specifier);
  const side = sideFromOutcome(row, r);
  if (!Number.isFinite(homeLine) || !side) return null;
  return side === 'home' ? homeLine : -homeLine;
}

function normalizeQuarterLine(v) {
  if (!Number.isFinite(v)) return null;
  if (Math.abs(v) < 0.001) return 0;
  if (Math.abs(v - 0.25) < 0.001) return 0.25;
  if (Math.abs(v + 0.25) < 0.001) return -0.25;
  return null;
}

function settlementMetrics({ odds, winProb, drawProb = 0, lossProb = 0, lineType = 'normal' }) {
  const o = Number(odds);
  const w = clamp(Number(winProb) || 0, 0, 1);
  const d = clamp(Number(drawProb) || 0, 0, 1);
  const l = clamp(Number(lossProb) || Math.max(0, 1 - w - d), 0, 1);
  let expectedReturn = w * o;
  let fairOdds = w > 0 ? 1 / w : Infinity;
  let fullWinProbability = w * 100;
  let nonLossProbability = w * 100;
  let settlementNote = 'Win/lose market';

  if (lineType === 'push0') {
    // DNB / Asian +0: draw returns the full stake.
    expectedReturn = w * o + d;
    fairOdds = w > 0 ? (1 - d) / w : Infinity;
    nonLossProbability = (w + d) * 100;
    settlementNote = 'Draw = full push';
  } else if (lineType === 'plus025') {
    // +0.25 = half stake at +0.0 and half at +0.5. Draw => half win, half push.
    expectedReturn = w * o + d * ((o + 1) / 2);
    fairOdds = (w + 0.5 * d) > 0 ? (1 - 0.5 * d) / (w + 0.5 * d) : Infinity;
    nonLossProbability = (w + d) * 100;
    settlementNote = 'Draw = half win / half push';
  } else if (lineType === 'minus025') {
    // -0.25 = half stake at 0.0 and half at -0.5. Draw => half loss, half push.
    expectedReturn = w * o + d * 0.5;
    fairOdds = w > 0 ? (1 - 0.5 * d) / w : Infinity;
    nonLossProbability = w * 100;
    settlementNote = 'Draw = half loss / half push';
  }

  const fairEquivalentProbability = Number.isFinite(fairOdds) && fairOdds > 1 ? 100 / fairOdds : 0;
  const impliedProbability = o > 1 ? 100 / o : 100;
  return {
    probability: round1(fairEquivalentProbability),
    fullWinProbability: round1(fullWinProbability),
    nonLossProbability: round1(nonLossProbability),
    impliedProbability: round1(impliedProbability),
    edge: round1(fairEquivalentProbability - impliedProbability),
    expectedValuePct: round1((expectedReturn - 1) * 100),
    expectedReturnMultiplier: Math.round(expectedReturn * 10000) / 10000,
    fairOdds: Number.isFinite(fairOdds) ? round2(fairOdds) : null,
    settlementNote,
  };
}

function normalMetrics(odds, probability) {
  const p = clamp(Number(probability) || 0, 0, 100);
  const o = Number(odds);
  const implied = o > 1 ? 100 / o : 100;
  return {
    probability: round1(p),
    fullWinProbability: round1(p),
    nonLossProbability: round1(p),
    impliedProbability: round1(implied),
    edge: round1(p - implied),
    expectedValuePct: round1(((p / 100) * o - 1) * 100),
    expectedReturnMultiplier: Math.round(((p / 100) * o) * 10000) / 10000,
    fairOdds: p > 0 ? round2(100 / p) : null,
    settlementNote: 'Win/lose market',
  };
}

function qualityFromMetrics(metrics, reliability) {
  const edgeScore = clamp(50 + metrics.edge * 4, 0, 100);
  return round1(clamp(
    metrics.probability * 0.55 + edgeScore * 0.25 + reliability * 100 * 0.20,
    0, 100
  ));
}

function candidate(selection, meta, metrics, probabilitySource, marketKey, betType = null) {
  if (!selection || !Number.isFinite(Number(selection.odds)) || Number(selection.odds) <= 1) return null;
  const reliability = MARKET_RELIABILITY[marketKey] || 0.80;
  return {
    eventId: String(selection.eventId), marketId: String(selection.marketId),
    outcomeId: String(selection.outcomeId), specifier: selection.specifier || null,
    odds: Number(selection.odds), sport: meta.sport, home: meta.home, away: meta.away,
    tournament: meta.tournament || '', marketDesc: selection.marketDesc || meta.marketDesc || '',
    outcomeDesc: selection.outcomeDesc || meta.outcomeDesc || '',
    probabilitySource, marketKind: marketKey.split(':')[1] || '',
    kickoffUtc: selection.kickoffUtc || meta.kickoffUtc || null,
    ...metrics,
    marketReliability: round1(reliability * 100),
    qualityScore: qualityFromMetrics(metrics, reliability),
    edgeType: /No-vig/i.test(probabilitySource) ? 'market-adjusted' : 'model-vs-price',
    betType: betType || meta.betType || marketKey,
  };
}

function matchingRows(r, rows) {
  return (rows || []).filter(x => teamMatches(r.home, x.home) && teamMatches(r.away, x.away));
}

function outcomeContains(row, values) {
  const d = String(row?.outcomeDesc || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return values.some(v => d === v || d.includes(v));
}

function oneXtwoCandidates(r, rows) {
  const ps = resultProbs(r);
  const fx = matchingRows(r, rows);
  const choices = [
    { betType:'home_win', side:'home', prob:ps.home*100, id:'1', patterns:['home', String(r.home).toLowerCase()] },
    { betType:'draw', side:'draw', prob:ps.draw*100, id:'2', patterns:['draw', 'x'] },
    { betType:'away_win', side:'away', prob:ps.away*100, id:'3', patterns:['away', String(r.away).toLowerCase()] },
  ];
  return choices.map(c => {
    const sp = fx.find(x => String(x.outcomeId) === c.id) || fx.find(x => outcomeContains(x, c.patterns));
    return sp ? candidate(sp, { sport:'Football', home:r.home, away:r.away, tournament:r.league, kickoffUtc:r.kickoffUtc }, normalMetrics(sp.odds, c.prob), 'Poisson + H2H', 'Football:1x2', c.betType) : null;
  }).filter(Boolean);
}

function ggCandidates(r, rows) {
  const yesProb = Number(r.btts || 0);
  const fx = matchingRows(r, rows);
  const configs = [
    { betType:'gg_yes', prob:yesProb, yes:true },
    { betType:'ng_no', prob:100-yesProb, yes:false },
  ];
  return configs.map(cfg => {
    const sp = fx.find(x => {
      const d = String(x.outcomeDesc || '').toLowerCase();
      return cfg.yes ? (d === 'gg' || d === 'yes' || /both.*yes|both teams.*score/.test(d))
        : (d === 'ng' || d === 'no' || /both.*no|not.*both/.test(d));
    });
    return sp ? candidate(sp, { sport:'Football', home:r.home, away:r.away, tournament:r.league, kickoffUtc:r.kickoffUtc }, normalMetrics(sp.odds, cfg.prob), 'Poisson + H2H', 'Football:gg', cfg.betType) : null;
  }).filter(Boolean);
}

function totalCandidate(r, rows, kind) {
  const isOver15 = kind === 'ou15';
  const prob = isOver15 ? Number(r.o15 || 0) : Number(r.u45 || 0);
  const fx = matchingRows(r, rows);
  const sp = fx.find(x => String(x.outcomeId) === (isOver15 ? '12' : '13'))
    || fx.find(x => isOver15 ? /over/i.test(x.outcomeDesc) : /under/i.test(x.outcomeDesc));
  const betType = isOver15 ? 'over15' : 'under45';
  return sp ? candidate(sp, { sport:'Football', home:r.home, away:r.away, tournament:r.league, kickoffUtc:r.kickoffUtc }, normalMetrics(sp.odds, prob), 'Poisson + H2H', `Football:${kind}`, betType) : null;
}

function doubleChanceCandidates(r, rows) {
  const ps = resultProbs(r);
  const fx = matchingRows(r, rows);
  const configs = [
    { betType:'dc_1x', label:'1X', prob:(ps.home + ps.draw)*100, patterns:['1x','home or draw','home/draw'] },
    { betType:'dc_x2', label:'X2', prob:(ps.draw + ps.away)*100, patterns:['x2','draw or away','draw/away'] },
  ];
  const out = [];
  for (const cfg of configs) {
    const sp = fx.find(x => outcomeContains(x, cfg.patterns));
    if (sp) out.push(candidate(sp, { sport:'Football', home:r.home, away:r.away, tournament:r.league, kickoffUtc:r.kickoffUtc }, normalMetrics(sp.odds, cfg.prob), 'Poisson + H2H', 'Football:dc', cfg.betType));
  }
  return out.filter(Boolean);
}

function dnbCandidates(r, rows) {
  const ps = resultProbs(r);
  const fx = matchingRows(r, rows);
  const out = [];
  for (const side of ['home','away']) {
    const sp = fx.find(x => sideFromOutcome(x, r) === side);
    if (!sp) continue;
    const w = side === 'home' ? ps.home : ps.away;
    const l = side === 'home' ? ps.away : ps.home;
    const metrics = settlementMetrics({ odds:sp.odds, winProb:w, drawProb:ps.draw, lossProb:l, lineType:'push0' });
    out.push(candidate(sp, { sport:'Football', home:r.home, away:r.away, tournament:r.league, kickoffUtc:r.kickoffUtc }, metrics, 'Poisson + H2H · settlement-aware DNB', 'Football:dnb', 'dnb'));
  }
  return out.filter(Boolean);
}

function asianCandidates(r, rows) {
  const ps = resultProbs(r);
  const fx = matchingRows(r, rows);
  const out = [];
  for (const sp of fx) {
    const side = sideFromOutcome(sp, r);
    const line = normalizeQuarterLine(selectedHandicap(sp, r));
    if (!side || line === null) continue;
    const w = side === 'home' ? ps.home : ps.away;
    const l = side === 'home' ? ps.away : ps.home;
    const lineType = line === 0 ? 'push0' : line === 0.25 ? 'plus025' : 'minus025';
    const metrics = settlementMetrics({ odds:sp.odds, winProb:w, drawProb:ps.draw, lossProb:l, lineType });
    const betType = line === 0 ? 'ah_0' : line === 0.25 ? 'ah_plus025' : 'ah_minus025';
    const c = candidate(sp, { sport:'Football', home:r.home, away:r.away, tournament:r.league, kickoffUtc:r.kickoffUtc }, metrics, `Poisson + H2H · settlement-aware AH ${line > 0 ? '+' : ''}${line}`, 'Football:ah', betType);
    if (c) {
      c.handicap = line;
      c.outcomeDesc = `${side === 'home' ? r.home : r.away} ${line > 0 ? '+' : ''}${line}`;
      out.push(c);
    }
  }
  const seen = new Set();
  return out.filter(c => {
    const k = `${c.outcomeDesc}|${c.odds}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function groupMarkets(rows) {
  const byEvent = new Map();
  for (const r of rows || []) {
    if (!byEvent.has(r.eventId)) byEvent.set(r.eventId, {
      eventId:r.eventId, home:r.home, away:r.away, tournament:r.tournament,
      kickoffUtc:r.kickoffUtc, groups:new Map(),
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
      const sum = inv.reduce((a,b)=>a+b,0); if (!sum) continue;
      const probs = inv.map(x=>x/sum);
      const spread = Math.max(...probs) - Math.min(...probs);
      if (spread < bestScore) { bestScore = spread; best = g; }
    }
    const inv = best.map(x => 1 / Number(x.odds));
    const sum = inv.reduce((a,b)=>a+b,0);
    const outcomes = best.map((x,i)=>({ ...x, marketProb:sum ? round1(inv[i]/sum*100) : 0 })).sort((a,b)=>b.marketProb-a.marketProb);
    return { ...ev, outcomes, topProb:outcomes[0]?.marketProb || 0, marketDesc:best[0]?.marketDesc || '' };
  }).filter(Boolean);
}

function buildCandidates({ predictions, footballMarkets, basketballWinner, hockeyWinner, minProbability = 55, minEdge = 0, leagues = null, sportScope = 'all', betTypes = null }) {
  const minProb = clamp(Number(minProbability) || 0, 0, 99);
  const edgeFloor = clamp(Number(minEdge) || 0, -25, 50);
  const leagueSet = Array.isArray(leagues) && leagues.length ? new Set(leagues) : null;
  const scope = ['all','football','basketball','hockey'].includes(String(sportScope).toLowerCase()) ? String(sportScope).toLowerCase() : 'all';
  const candidates = [];
  const betTypeSet = Array.isArray(betTypes) ? new Set(betTypes.map(String)) : null;
  const allowed = c => !betTypeSet || betTypeSet.has(String(c.betType));

  if (scope === 'all' || scope === 'football') {
    for (const r of predictions?.matches || []) {
      if (leagueSet && !leagueSet.has(r.league)) continue;
      const generated = [
        ...oneXtwoCandidates(r, footballMarkets?.['1x2']?.rows || []),
        ...ggCandidates(r, footballMarkets?.gg?.rows || []),
        totalCandidate(r, footballMarkets?.ou15?.rows || [], 'ou15'),
        totalCandidate(r, footballMarkets?.ou45?.rows || [], 'ou45'),
        ...doubleChanceCandidates(r, footballMarkets?.dc?.rows || []),
        ...dnbCandidates(r, footballMarkets?.dnb?.rows || []),
        ...asianCandidates(r, footballMarkets?.ah?.rows || []),
      ].filter(Boolean);
      for (const c of generated) {
        if (allowed(c) && c.probability >= minProb && c.edge >= edgeFloor) candidates.push(c);
      }
    }
  }

  for (const [sport,payload,scopeKey] of [['Basketball',basketballWinner,'basketball'],['Ice Hockey',hockeyWinner,'hockey']]) {
    if (scope !== 'all' && scope !== scopeKey) continue;
    const events = groupMarkets(payload?.rows || []);
    for (const e of events) {
      const top = e.outcomes[0];
      if (!top || Number(top.marketProb) < minProb) continue;
      const metrics = normalMetrics(top.odds, top.marketProb);
      const bt = scopeKey === 'basketball' ? 'basketball_winner' : 'hockey_winner';
      const c = candidate(top, { sport,home:e.home,away:e.away,tournament:e.tournament,marketDesc:top.marketDesc,outcomeDesc:top.outcomeDesc,kickoffUtc:e.kickoffUtc }, metrics, 'No-vig market probability', `${sport}:winner`, bt);
      if (c && allowed(c)) candidates.push(c);
    }
  }

  return candidates.sort((a,b)=>b.qualityScore-a.qualityScore || b.probability-a.probability || a.odds-b.odds);
}

function evaluateCombo(combo, targetOdds) {
  const combinedOdds = combo.reduce((p,x)=>p*x.odds,1);
  const avgProbability = combo.reduce((s,x)=>s+x.probability,0) / Math.max(1,combo.length);
  const minProbability = combo.reduce((m,x)=>Math.min(m,x.probability),100);
  const avgEdge = combo.reduce((s,x)=>s+x.edge,0) / Math.max(1,combo.length);
  const avgQualityScore = combo.reduce((s,x)=>s+x.qualityScore,0) / Math.max(1,combo.length);
  // For DNB/AH quarter lines, probability is the settlement-aware fair-price-equivalent
  // probability, not a literal all-legs full-win probability.
  const estimatedSlipProbability = combo.reduce((p,x)=>p*clamp(x.probability/100,0,1),1)*100;
  const fairSlipOdds = estimatedSlipProbability > 0 ? 100/estimatedSlipProbability : null;
  const estimatedSlipEVPct = (combo.reduce((m,x)=>m*(Number(x.expectedReturnMultiplier)||1),1)-1)*100;
  const distance = Math.abs(Math.log(Math.max(combinedOdds,1.000001)/targetOdds));
  const belowPenalty = combinedOdds + 1e-9 < targetOdds ? 0.12 : 0;
  const score = distance + belowPenalty - (avgQualityScore/100)*0.16 - clamp(avgEdge,-20,20)*0.0025 + combo.length*0.0015;
  return { combinedOdds,avgProbability,minProbability,avgEdge,avgQualityScore,estimatedSlipProbability,fairSlipOdds,estimatedSlipEVPct,score,reachedTarget:combinedOdds>=targetOdds };
}

function weightedOrder(candidates, rng = Math.random) {
  return candidates.map(c => {
    const q = clamp(c.qualityScore/100,0.01,0.999), p = clamp(c.probability/100,0.01,0.999);
    const w = Math.pow(q*0.65+p*0.35,5);
    return { c,key:-Math.log(Math.max(1e-12,rng()))/w };
  }).sort((a,b)=>a.key-b.key).map(x=>x.c);
}

function selectAutoBet(candidates, { targetOdds=5,maxSelections=8,trials=1200,minQualityScore=0,requirePositiveEV=false,rng=Math.random } = {}) {
  const target = clamp(Number(targetOdds)||5,1.05,2000);
  const maxLegs = clamp(parseInt(maxSelections,10)||8,1,30);
  const qualityFloor = clamp(Number(minQualityScore)||0,0,100);
  const usable = (candidates||[]).filter(c=>Number.isFinite(c.odds)&&c.odds>1&&c.probability>0&&c.qualityScore>=qualityFloor&&(!requirePositiveEV||c.expectedValuePct>0));
  if (!usable.length) return { selections:[],targetOdds:target,combinedOdds:1,reachedTarget:false,candidateCount:0 };
  let best = null;
  const totalTrials = clamp(parseInt(trials,10)||1200,50,5000);
  const orders = [usable.slice().sort((a,b)=>b.qualityScore-a.qualityScore||b.probability-a.probability)];
  for (let i=1;i<totalTrials;i++) orders.push(weightedOrder(usable,rng));
  for (const order of orders) {
    const combo=[], events=new Set(); let product=1;
    for (const c of order) {
      if (combo.length>=maxLegs || events.has(c.eventId)) continue;
      combo.push(c); events.add(c.eventId); product*=c.odds;
      const evalNow=evaluateCombo(combo,target);
      if (!best || evalNow.score<best.metrics.score) best={selections:combo.slice(),metrics:evalNow};
      if (product>=target) break;
    }
  }
  if (!best) return { selections:[],targetOdds:target,combinedOdds:1,reachedTarget:false,candidateCount:usable.length };
  const m=best.metrics;
  return {
    selections:best.selections,targetOdds:target,combinedOdds:round2(m.combinedOdds),reachedTarget:m.reachedTarget,
    averageProbability:round1(m.avgProbability),minimumProbability:round1(m.minProbability),averageEdge:round1(m.avgEdge),
    averageQualityScore:round1(m.avgQualityScore),estimatedSlipProbability:Math.round(m.estimatedSlipProbability*1000)/1000,
    fairSlipOdds:m.fairSlipOdds?round2(m.fairSlipOdds):null,estimatedSlipEVPct:round1(m.estimatedSlipEVPct),candidateCount:usable.length,
    probabilityNote:'For DNB and Asian +0/+0.25/-0.25, probability is settlement-aware fair-price-equivalent probability because draws can push or half-settle.',
  };
}

module.exports = { buildCandidates, selectAutoBet, groupMarkets, normTeam, teamMatches, MARKET_RELIABILITY, settlementMetrics, normalMetrics, parseHomeHandicap, selectedHandicap };
