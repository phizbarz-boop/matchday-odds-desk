// Match actual full-time, side-specific goal totals; never confuse with match totals or corners.
'use strict';

function isTeamTotalSelection(row, side, line, direction) {
  if (!['home', 'away'].includes(side) || !['over', 'under'].includes(direction)) return false;
  const name = String(row?.marketDesc || '').toLowerCase();
  const outcome = String(row?.outcomeDesc || '').toLowerCase();
  const spec = String(row?.specifier || '').toLowerCase().replace(/\s+/g, '');
  if (/corner|half|period|quarter|card|shot|throw|extra time/.test(name)) return false;
  if (!new RegExp(`\\b${side}\\b`).test(name)) return false;
  if (!/total|goals?|over\/under/.test(name)) return false;
  if (/\bover\b/.test(outcome) && direction !== 'over') return false;
  if (/\bunder\b/.test(outcome) && direction !== 'under') return false;
  if (!new RegExp(`\\b${direction}\\b`).test(outcome) &&
      String(row?.outcomeId || '') !== (direction === 'over' ? '12' : '13')) return false;
  if (spec) return spec === `total=${line}`;
  const escaped = String(line).replace('.', '\\.');
  return new RegExp(`(?:^|[^0-9])${escaped}(?:$|[^0-9])`).test(`${outcome} ${name}`);
}

module.exports = { isTeamTotalSelection };
