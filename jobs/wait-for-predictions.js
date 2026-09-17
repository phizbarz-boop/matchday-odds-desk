'use strict';

// /api/refresh acknowledges that a detached subprocess STARTED; it does not
// mean the new payload has been stored. Exit nonzero if predictions never
// advance, so a misleading successful GitHub Actions refresh is impossible.
const baseUrl = String(process.env.MATCHDAY_BASE_URL || 'https://matchday-odds-desk.onrender.com').replace(/\/$/, '');
const since = Date.parse(String(process.env.REFRESH_STARTED_AT || ''));
const maxWaitMs = Math.max(1000, Number(process.env.REFRESH_WAIT_MS || 22 * 60 * 1000));
const pollMs = Math.max(100, Number(process.env.REFRESH_POLL_MS || 20000));
if (!Number.isFinite(since)) {
  console.error('Missing/invalid REFRESH_STARTED_AT from the preceding action step.');
  process.exit(1);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const deadline = Date.now() + maxWaitMs;
  let last = 'not checked';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/predictions`, { signal: AbortSignal.timeout(15000), headers: {'Cache-Control':'no-cache'} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const generation = Date.parse(payload.generatedAt || '');
      const rows = Array.isArray(payload.matches) ? payload.matches.length : 0;
      last = `generatedAt=${payload.generatedAt || 'missing'}, fixtures=${rows}`;
      // date -u outputs second precision; allow <1 s rounding margin.
      if (rows > 0 && Number.isFinite(generation) && generation >= since - 1000) {
        console.log(`SUCCESS: daily prediction refresh persisted: ${last}`);
        return;
      }
      console.log(`Waiting for refresh completion: ${last}`);
    } catch (err) {
      last = err.message;
      console.warn(`Waiting for predictions API: ${last}`);
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline-Date.now())));
  }
  throw new Error(`Refresh did not persist new nonempty predictions within ${maxWaitMs/60000} minutes; last result: ${last}`);
})().catch(err => { console.error(err.message); process.exitCode=1; });
