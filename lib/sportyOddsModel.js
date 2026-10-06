// Builds the football probability rows the Auto Builder consumes directly from
// SportyBet's own odds — prematch snapshot payloads or live board rows. No
// external data API is involved anywhere in this file.
//
// Method: every bookmaker market group (one event + one market + one line) is
// de-vigged with proportional no-vig normalisation (p_i = 1/odds_i, scaled to
// sum to 1). 1X2 gives the match-result probabilities, GG/NG gives BTTS, the
// Over/Under specifier lines (total=0.5/1.5/2.5/4.5) give the goal-line
// probabilities, Home/Away Total gives team-goal probabilities, Correct Score
// gives the most likely exact score, and the corners O/U line is inverted
// through a Poisson CDF to recover the corner-rate lambda the picker model
// consumes. A row is only produced when a real 1X2 market was de-vigged —
// probabilities are never invented for events SportyBet is not pricing.

'use strict';

const norm = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const compact = v => norm(v).replace(/\s+/g, '');

function teamMatch(a, b) {
  const x = compact(a), y = compact(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x));
}

// Same normalisation as server.js fixtureKey so dedupe across Poisson + H2H
// snapshot rows and odds-derived rows uses identical keys.
function fixtureKey(r) {
  const n = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(fc|cf|afc|sc|ssc|club|football|futbol|calcio)\b/g, '').replace(/[^a-z0-9]+/g, '');
  return `${n(r?.home)}|${n(r?.away)}|${String(r?.kickoffUtc || '').slice(0, 10)}`;
}

function parseTotalLine(row) {
  const s = String(row?.specifier || '');
  const m = s.match(/total\s*=\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (m) return Number(m[1]);
  const d = String(row?.outcomeDesc || '');
  const m2 = d.match(/([0-9]+(?:\.[0-9]+)?)/);
  return m2 ? Number(m2[1]) : null;
}

// Proportional no-vig: implied probability of each outcome scaled so the group
// sums to 1. Returns a Map from row to probability (0..1).
function deVig(groupRows) {
  const out = new Map();
  let sum = 0;
  for (const r of groupRows || []) {
    const o = Number(r?.odds);
    if (!Number.isFinite(o) || o <= 1) continue;
    const p = 1 / o;
    out.set(r, p);
    sum += p;
  }
  if (!(sum > 0)) return new Map();
  for (const [r, p] of out) out.set(r, p / sum);
  return out;
}

function poissonPmf(k, lambda) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / fact;
}

function poissonCdf(n, lambda) {
  let s = 0;
  for (let k = 0; k <= n; k++) s += poissonPmf(k, lambda);
  return s;
}

// Recover the Poisson rate lambda behind a quoted Over line: find lambda such
// that P(X > line) = pOver. Bisection on [0.05, 30] is plenty for corners/goals.
function invertPoissonOver(pOver, line) {
  const target = Number(pOver);
  const floor = Math.floor(Number(line));
  if (!Number.isFinite(target) || target <= 0 || target >= 1 || !Number.isFinite(floor)) return null;
  let lo = 0.05, hi = 30;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const over = 1 - poissonCdf(floor, mid);
    if (over > target) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

const isOverOutcome = r => /\bover\b/i.test(String(r?.outcomeDesc || '')) || String(r?.outcomeId || '') === '12';
const isUnderOutcome = r => /\bunder\b/i.test(String(r?.outcomeDesc || '')) || String(r?.outcomeId || '') === '13';

function classify1x2(row, home, away) {
  const d = norm(row?.outcomeDesc);
  if (d === 'draw' || d === 'x') return 'draw';
  if (d === 'home' || d === '1') return 'home';
  if (d === 'away' || d === '2') return 'away';
  if (teamMatch(row?.outcomeDesc, home)) return 'home';
  if (teamMatch(row?.outcomeDesc, away)) return 'away';
  return null;
}

function isFirstHalfText(...parts) {
  return /(1st|first)\s*half|\b1h\b/i.test(parts.map(p => String(p || '')).join(' '));
}

// Group one event's outcome rows into market groups keyed by marketId + line.
function marketGroups(evRows) {
  const groups = new Map();
  for (const r of evRows) {
    const key = `${String(r?.marketId || '')}|${String(r?.specifier || '')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

// De-vig the Over/Under line pairs of a market family into { line: pOver }.
// pred selects which market groups belong to the family.
function totalsLines(groups, pred) {
  const lines = {};
  for (const rows of groups.values()) {
    const first = rows[0] || {};
    if (!pred(first, rows)) continue;
    const line = parseTotalLine(first);
    if (!Number.isFinite(line)) continue;
    const probs = deVig(rows);
    let over = null;
    for (const [r, p] of probs) if (isOverOutcome(r)) { over = p; break; }
    if (over === null) {
      // Single-outcome group or unusual ids: try to pair by desc inside the group.
      for (const [r, p] of probs) if (isUnderOutcome(r)) { over = 1 - p; break; }
    }
    if (over !== null && over > 0 && over < 1) lines[line] = over;
  }
  return lines;
}

function buildEventModel(ev) {
  const rows = ev.rows;
  const groups = marketGroups(rows);
  const home = ev.home, away = ev.away;

  // --- 1X2 (required: the backbone of the row) ---
  let h = null, d = null, a = null;
  for (const [key, gRows] of groups) {
    const marketId = key.split('|')[0];
    const desc = norm(gRows[0]?.marketDesc);
    if (!(marketId === '1' || desc === '1x2' || desc === '1x2 ft' || desc === 'match result' || desc === 'fulltime result')) continue;
    const probs = deVig(gRows);
    const parts = { home: null, draw: null, away: null };
    for (const [r, p] of probs) {
      const side = classify1x2(r, home, away);
      if (side) parts[side] = p;
    }
    if (parts.home !== null && parts.draw !== null && parts.away !== null) {
      h = parts.home; d = parts.draw; a = parts.away;
      break;
    }
  }
  if (h === null) return null; // SportyBet is not pricing this event's result: no row.

  // --- GG/NG ---
  let btts = null;
  for (const [key, gRows] of groups) {
    const marketId = key.split('|')[0];
    const desc = norm(gRows[0]?.marketDesc);
    if (!(marketId === '29' || desc.includes('gg') || desc.includes('both teams to score'))) continue;
    const probs = deVig(gRows);
    for (const [r, p] of probs) {
      const dd = norm(r?.outcomeDesc);
      if (dd === 'gg' || dd === 'yes' || /both.*yes/.test(dd)) { btts = p; break; }
      if (dd === 'ng' || dd === 'no' || /both.*no/.test(dd)) { btts = 1 - p; break; }
    }
    if (btts !== null) break;
  }

  // --- Full-match goal lines (Over/Under with total= specifiers) ---
  const goalLines = totalsLines(groups, first => {
    const desc = norm(first?.marketDesc);
    if (/corner/i.test(desc)) return false;
    if (isFirstHalfText(first?.marketDesc, first?.specifier)) return false;
    return desc === 'over/under' || desc === 'total' || desc === 'over under' || String(first?.marketId || '') === '18';
  });

  // --- Team totals (Home Total / Away Total) ---
  const homeLines = totalsLines(groups, first => /home total|total home/.test(norm(first?.marketDesc)) && !isFirstHalfText(first?.marketDesc, first?.specifier));
  const awayLines = totalsLines(groups, first => /away total|total away/.test(norm(first?.marketDesc)) && !isFirstHalfText(first?.marketDesc, first?.specifier));

  // --- Correct score: de-vig the whole group, take the most likely scoreline ---
  let score = null, scoreP = null;
  for (const [key, gRows] of groups) {
    const desc = norm(gRows[0]?.marketDesc);
    if (!desc.includes('correct score')) continue;
    const probs = deVig(gRows);
    let best = null, bestP = 0;
    for (const [r, p] of probs) {
      const m = String(r?.outcomeDesc || '').trim().replace(/\s+/g, '').replace(':', '-').match(/^(\d+)-(\d+)$/);
      if (m && p > bestP) { best = `${Number(m[1])}-${Number(m[2])}`; bestP = p; }
    }
    if (best) { score = best; scoreP = bestP; break; }
  }

  // --- 1UP ---
  let oneUpHome = null, oneUpAway = null;
  for (const [key, gRows] of groups) {
    const desc = norm(gRows[0]?.marketDesc);
    if (!desc.includes('1up')) continue;
    const probs = deVig(gRows);
    for (const [r, p] of probs) {
      const dd = norm(r?.outcomeDesc);
      const id = String(r?.outcomeId || '');
      if (id === '1' || dd === 'home' || teamMatch(r?.outcomeDesc, home)) oneUpHome = p;
      else if (id === '3' || dd === 'away' || teamMatch(r?.outcomeDesc, away)) oneUpAway = p;
    }
    break;
  }

  // --- Corners: invert the main full-match corners O/U line through Poisson ---
  let corners = null;
  const cornerLines = totalsLines(groups, (first, gRows) => {
    const text = `${first?.marketDesc || ''} ${gRows.map(x => x?.outcomeDesc || '').join(' ')}`;
    if (!/corner/i.test(text)) return false;
    if (isFirstHalfText(first?.marketDesc, first?.specifier, ...gRows.map(x => x?.outcomeDesc))) return false;
    return true;
  });
  const lineEntries = Object.entries(cornerLines);
  if (lineEntries.length) {
    // The main line is the one priced closest to 50/50.
    lineEntries.sort((x, y) => Math.abs(x[1] - 0.5) - Math.abs(y[1] - 0.5));
    const [mainLine, pOver] = lineEntries[0];
    const totalLambda = invertPoissonOver(pOver, Number(mainLine));
    if (totalLambda && totalLambda > 0) {
      // Home/away split: a corners 1X2 market if quoted, else scaled by the
      // match-win supremacy (stronger side attacks more).
      let homeShare = null;
      for (const [key, gRows] of groups) {
        const desc = norm(gRows[0]?.marketDesc);
        if (!desc.includes('corner')) continue;
        if (!(desc.includes('1x2') || desc.includes('winner') || desc.includes('result'))) continue;
        const probs = deVig(gRows);
        let ph = null, pa = null;
        for (const [r, p] of probs) {
          const side = classify1x2(r, home, away);
          if (side === 'home') ph = p;
          else if (side === 'away') pa = p;
        }
        if (ph !== null && pa !== null && ph + pa > 0) homeShare = ph / (ph + pa);
        break;
      }
      if (homeShare === null) {
        homeShare = Math.min(0.68, Math.max(0.32, 0.5 + 0.35 * (h - a)));
      }
      homeShare = Math.min(0.7, Math.max(0.3, homeShare));
      const firstHalfShare = Math.max(0.25, Math.min(0.65, Number(process.env.SPORTY_1H_CORNER_SHARE || 0.46)));
      const homeLambda = totalLambda * homeShare;
      const awayLambda = totalLambda * (1 - homeShare);
      corners = {
        totalLambda: Math.round(totalLambda * 100) / 100,
        homeLambda: Math.round(homeLambda * 100) / 100,
        awayLambda: Math.round(awayLambda * 100) / 100,
        firstHalfHomeLambda: Math.round(homeLambda * firstHalfShare * 100) / 100,
        firstHalfAwayLambda: Math.round(awayLambda * firstHalfShare * 100) / 100,
        firstHalfShare: Math.round(firstHalfShare * 1000) / 1000,
        source: 'SportyBet corners line (no-vig Poisson inversion)',
      };

      // Explicit 1st-half team-corner lines (total=0.5 etc.) sharpen the split.
      const fh = { home: {}, away: {} };
      for (const [key, gRows] of groups) {
        const first = gRows[0] || {};
        const text = `${first?.marketDesc || ''} ${first?.specifier || ''} ${gRows.map(x => x?.outcomeDesc || '').join(' ')}`;
        if (!/corner/i.test(text) || !isFirstHalfText(text)) continue;
        let side = null;
        if (teamMatch(first?.marketDesc, home) || gRows.some(x => teamMatch(x?.outcomeDesc, home)) || /\bhome\b/i.test(text)) side = 'home';
        if (teamMatch(first?.marketDesc, away) || gRows.some(x => teamMatch(x?.outcomeDesc, away)) || /\baway\b/i.test(text)) {
          if (side) { side = null; } else side = 'away';
        }
        if (!side) continue;
        const line = parseTotalLine(first);
        if (!Number.isFinite(line)) continue;
        const probs = deVig(gRows);
        for (const [r, p] of probs) if (isOverOutcome(r)) { fh[side][line] = p; break; }
      }
      for (const side of ['home', 'away']) {
        const p05 = fh[side][0.5];
        if (p05 > 0 && p05 < 1) {
          const lam = -Math.log(1 - p05);
          if (Number.isFinite(lam) && lam > 0) {
            if (side === 'home') corners.firstHalfHomeLambda = Math.round(lam * 100) / 100;
            else corners.firstHalfAwayLambda = Math.round(lam * 100) / 100;
          }
        }
      }
    }
  }

  const pct = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 100);
  const hh = Math.round(h * 100), dd = Math.round(d * 100), aa = Math.round(a * 100);
  const pickIdx = [hh, dd, aa].indexOf(Math.max(hh, dd, aa));
  return {
    eventId: ev.eventId,
    sportyEventId: ev.eventId,
    home, away,
    league: ev.tournament || '',
    leagueCode: 'sporty:odds',
    kickoffUtc: ev.kickoffUtc || null,
    h: hh, d: dd, a: aa,
    btts: pct(btts),
    o05: pct(goalLines[0.5]), o15: pct(goalLines[1.5]), o25: pct(goalLines[2.5]),
    u45: goalLines[4.5] !== undefined ? Math.round((1 - goalLines[4.5]) * 100) : null,
    homeO05: pct(homeLines[0.5]), awayO05: pct(awayLines[0.5]),
    homeU45: homeLines[4.5] !== undefined ? Math.round((1 - homeLines[4.5]) * 100) : null,
    awayU45: awayLines[4.5] !== undefined ? Math.round((1 - awayLines[4.5]) * 100) : null,
    oneUpHome: pct(oneUpHome) ?? 0,
    oneUpAway: pct(oneUpAway) ?? 0,
    score, scoreP: scoreP === null ? null : Math.round(scoreP * 100),
    pick: ['Home Win', 'Draw', 'Away Win'][pickIdx],
    pickProb: Math.max(hh, dd, aa),
    corners: corners || undefined,
    live: ev.live === true,
    dataSource: ev.live === true ? 'SportyBet live odds (no-vig)' : 'SportyBet odds (no-vig)',
  };
}

// Build model rows from SportyBet outcome rows. Input: array of payloads
// ({rows:[...]}) and/or plain row arrays. live: true keeps only rows tagged
// live (live board), false keeps only non-live rows, undefined keeps both.
function buildRowsFromOdds(inputs, { live } = {}) {
  const allRows = [];
  for (const input of inputs || []) {
    const rows = Array.isArray(input) ? input : (Array.isArray(input?.rows) ? input.rows : []);
    allRows.push(...rows);
  }
  const events = new Map();
  for (const r of allRows) {
    const isLive = r?.live === true;
    if (live === true && !isLive) continue;
    if (live === false && isLive) continue;
    const eventId = String(r?.eventId || '');
    const key = eventId || `${norm(r?.home)}|${norm(r?.away)}|${String(r?.kickoffUtc || '').slice(0, 10)}`;
    if (!key || key === '||') continue;
    if (!events.has(key)) {
      events.set(key, {
        eventId, home: r?.home || '', away: r?.away || '',
        tournament: r?.tournament || '', kickoffUtc: r?.kickoffUtc || null,
        live: isLive, rows: [],
      });
    }
    const ev = events.get(key);
    if (isLive) ev.live = true;
    ev.rows.push(r);
  }
  const out = [];
  for (const ev of events.values()) {
    if (!ev.home || !ev.away) continue;
    const row = buildEventModel(ev);
    if (row) out.push(row);
  }
  return out;
}

// Append odds-model rows for events the saved predictions do not cover.
// Existing Poisson + H2H rows always win — this only fills gaps.
function appendUncoveredRows(matches, oddsRows) {
  const list = Array.isArray(matches) ? matches : [];
  const coveredIds = new Set(list.map(r => String(r?.eventId || r?.sportyEventId || '')).filter(Boolean));
  const coveredKeys = new Set(list.map(fixtureKey));
  const stats = { modeled: Array.isArray(oddsRows) ? oddsRows.length : 0, added: 0, alreadyCovered: 0 };
  for (const r of oddsRows || []) {
    const id = String(r?.eventId || '');
    if ((id && coveredIds.has(id)) || coveredKeys.has(fixtureKey(r))) { stats.alreadyCovered++; continue; }
    if (id) coveredIds.add(id);
    coveredKeys.add(fixtureKey(r));
    list.push(r);
    stats.added++;
  }
  return { matches: list, stats };
}

// Corner models from corner-market rows alone (no 1X2 required): used to attach
// corner lambdas to existing Poisson + H2H prediction rows. Returns a Map keyed
// by both eventId and fixtureKey so either identifier resolves.
function buildCornerModelsByEvent(inputs) {
  const allRows = [];
  for (const input of inputs || []) {
    const rows = Array.isArray(input) ? input : (Array.isArray(input?.rows) ? input.rows : []);
    allRows.push(...rows);
  }
  const events = new Map();
  for (const r of allRows) {
    const eventId = String(r?.eventId || '');
    const key = eventId || `${norm(r?.home)}|${norm(r?.away)}|${String(r?.kickoffUtc || '').slice(0, 10)}`;
    if (!key || key === '||') continue;
    if (!events.has(key)) {
      events.set(key, { eventId, home: r?.home || '', away: r?.away || '', kickoffUtc: r?.kickoffUtc || null, rows: [] });
    }
    events.get(key).rows.push(r);
  }
  const out = new Map();
  for (const ev of events.values()) {
    if (!ev.home || !ev.away) continue;
    const groups = marketGroups(ev.rows);
    const cornerLines = totalsLines(groups, (first, gRows) => {
      const text = `${first?.marketDesc || ''} ${gRows.map(x => x?.outcomeDesc || '').join(' ')}`;
      if (!/corner/i.test(text)) return false;
      if (isFirstHalfText(first?.marketDesc, first?.specifier, ...gRows.map(x => x?.outcomeDesc))) return false;
      return true;
    });
    const lineEntries = Object.entries(cornerLines);
    if (!lineEntries.length) continue;
    lineEntries.sort((x, y) => Math.abs(x[1] - 0.5) - Math.abs(y[1] - 0.5));
    const totalLambda = invertPoissonOver(lineEntries[0][1], Number(lineEntries[0][0]));
    if (!totalLambda || !(totalLambda > 0)) continue;
    let homeShare = null;
    for (const gRows of groups.values()) {
      const desc = norm(gRows[0]?.marketDesc);
      if (!desc.includes('corner')) continue;
      if (!(desc.includes('1x2') || desc.includes('winner') || desc.includes('result'))) continue;
      const probs = deVig(gRows);
      let ph = null, pa = null;
      for (const [r, p] of probs) {
        const side = classify1x2(r, ev.home, ev.away);
        if (side === 'home') ph = p;
        else if (side === 'away') pa = p;
      }
      if (ph !== null && pa !== null && ph + pa > 0) homeShare = ph / (ph + pa);
      break;
    }
    if (homeShare === null) homeShare = 0.535; // neutral home-corner edge
    homeShare = Math.min(0.7, Math.max(0.3, homeShare));
    const firstHalfShare = Math.max(0.25, Math.min(0.65, Number(process.env.SPORTY_1H_CORNER_SHARE || 0.46)));
    const homeLambda = totalLambda * homeShare;
    const awayLambda = totalLambda * (1 - homeShare);
    const corners = {
      totalLambda: Math.round(totalLambda * 100) / 100,
      homeLambda: Math.round(homeLambda * 100) / 100,
      awayLambda: Math.round(awayLambda * 100) / 100,
      firstHalfHomeLambda: Math.round(homeLambda * firstHalfShare * 100) / 100,
      firstHalfAwayLambda: Math.round(awayLambda * firstHalfShare * 100) / 100,
      firstHalfShare: Math.round(firstHalfShare * 1000) / 1000,
      source: 'SportyBet corners line (no-vig Poisson inversion)',
    };
    // Explicit 1st-half team-corner lines sharpen the split when quoted.
    const fh = { home: {}, away: {} };
    for (const gRows of groups.values()) {
      const first = gRows[0] || {};
      const text = `${first?.marketDesc || ''} ${first?.specifier || ''} ${gRows.map(x => x?.outcomeDesc || '').join(' ')}`;
      if (!/corner/i.test(text) || !isFirstHalfText(text)) continue;
      let side = null;
      if (teamMatch(first?.marketDesc, ev.home) || gRows.some(x => teamMatch(x?.outcomeDesc, ev.home)) || /\bhome\b/i.test(text)) side = 'home';
      if (teamMatch(first?.marketDesc, ev.away) || gRows.some(x => teamMatch(x?.outcomeDesc, ev.away)) || /\baway\b/i.test(text)) {
        if (side) { side = null; } else side = 'away';
      }
      if (!side) continue;
      const line = parseTotalLine(first);
      if (!Number.isFinite(line)) continue;
      const probs = deVig(gRows);
      for (const [r, p] of probs) if (isOverOutcome(r)) { fh[side][line] = p; break; }
    }
    for (const side of ['home', 'away']) {
      const p05 = fh[side][0.5];
      if (p05 > 0 && p05 < 1) {
        const lam = -Math.log(1 - p05);
        if (Number.isFinite(lam) && lam > 0) {
          if (side === 'home') corners.firstHalfHomeLambda = Math.round(lam * 100) / 100;
          else corners.firstHalfAwayLambda = Math.round(lam * 100) / 100;
        }
      }
    }
    if (ev.eventId) out.set(ev.eventId, corners);
    out.set(fixtureKey(ev), corners);
  }
  return out;
}

module.exports = {
  buildRowsFromOdds,
  appendUncoveredRows,
  buildCornerModelsByEvent,
  fixtureKey,
  deVig,
  invertPoissonOver,
  poissonPmf,
  poissonCdf,
};
