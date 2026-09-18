'use strict';

// Nigeria does not observe daylight saving time; use the named timezone for
// day boundaries instead of relying on the server's host timezone.
const TIME_ZONE = 'Africa/Lagos';
function watDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const part = name => parts.find(x => x.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function watMinuteOfDay(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const part = name => Number(parts.find(x => x.type === name)?.value);
  return part('hour') * 60 + part('minute');
}
function isScheduledTime(kind, value = new Date()) {
  const minute = watMinuteOfDay(value);
  if (kind === 'refresh') return minute >= 7 * 60 && minute < 8 * 60 + 15;
  if (kind === 'telegram') return minute >= 8 * 60 + 30 && minute < 9 * 60 + 30;
  throw new Error(`Unknown daily schedule kind: ${kind}`);
}
module.exports = { TIME_ZONE, watDateKey, watMinuteOfDay, isScheduledTime };
