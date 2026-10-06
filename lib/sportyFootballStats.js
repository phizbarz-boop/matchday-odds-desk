'use strict';

// Only fields actually displayed by SportyBet's embedded match statistics.
// Missing numbers stay null: a blank statistic is never interpreted as zero.
function number(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseDisplayedStats(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const result = {};
  // SportyBet's tracker displays: home value / SCORED / away value,
  // then home value / CONCEDED / away value. Read only that H2H panel.
  const start = lines.findIndex(s => /^previous meetings$/i.test(s));
  if (start < 0) return result;
  const panel = lines.slice(start, start + 35);
  for (const [label, home, away] of [['SCORED','homeGoalsFor','awayGoalsFor'], ['CONCEDED','homeGoalsAgainst','awayGoalsAgainst']]) {
    const i = panel.findIndex(s => s.toUpperCase() === label);
    if (i > 0 && i + 1 < panel.length) {
      const h = number(panel[i-1]), a = number(panel[i+1]);
      if (h !== null && a !== null && h <= 10 && a <= 10) { result[home] = h; result[away] = a; }
    }
  }
  const meetings = panel.slice(1, 7);
  if (meetings.length === 6 && /^wins$/i.test(meetings[3]) && /^draws$/i.test(meetings[4]) && /^wins$/i.test(meetings[5])) {
    const values = meetings.slice(0,3).map(number);
    if (values.every(x => x !== null && Number.isInteger(x)) && values.reduce((a,b) => a+b,0) <= 100) {
      [result.h2hHomeWins,result.h2hDraws,result.h2hAwayWins] = values;
    }
  }
  return result;
}

function sanitizeStats(row) {
  if (!row || !/^sr:match:\d+$/.test(String(row.eventId || ''))) return null;
  if (!row.home || !row.away) return null;
  const captured = Date.parse(row.capturedAt || '');
  if (!Number.isFinite(captured) || captured > Date.now() + 60000) return null;
  const result = { eventId:String(row.eventId), home:String(row.home).slice(0,160), away:String(row.away).slice(0,160),
    capturedAt:new Date(captured).toISOString(), source:'SportyBet displayed statistics' };
  for (const field of ['homeGoalsFor','awayGoalsFor','homeGoalsAgainst','awayGoalsAgainst']) {
    const n = number(row[field]);
    if (n !== null && n <= 10) result[field] = n;
  }
  for (const field of ['h2hHomeWins','h2hDraws','h2hAwayWins']) {
    const n = number(row[field]);
    if (n !== null && Number.isInteger(n) && n <= 100) result[field] = n;
  }
  // Optional real recent corner profiles, accepted only with explicit sample counts.
  for (const side of ['home','away']) {
    const p = row[`${side}CornerProfile`];
    if (p && Number.isInteger(p.samples) && p.samples >= 2 && p.samples <= 100 &&
        number(p.cornersFor) !== null && number(p.cornersAgainst) !== null && p.cornersFor <= 30 && p.cornersAgainst <= 30) {
      result[`${side}CornerProfile`] = { samples:p.samples, cornersFor:p.cornersFor, cornersAgainst:p.cornersAgainst };
    }
  }
  return result;
}

module.exports = { parseDisplayedStats, sanitizeStats };
