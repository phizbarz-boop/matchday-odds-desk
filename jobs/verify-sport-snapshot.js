'use strict';
// Verifies the saved snapshot via the same API that serves the website.
// A green collector job must not merely indicate that a script launched.
const sport = String(process.env.SPORT_NAME || '').trim().toLowerCase();
const allowed = new Set(['handball', 'volleyball', 'tennis']);
if (!allowed.has(sport)) {
  console.error('SPORT_NAME must be one of handball, volleyball, tennis');
  process.exit(1);
}
const since = Date.parse(process.env.SPORT_REFRESH_STARTED_AT || '');
if (!Number.isFinite(since)) {
  console.error('Missing SPORT_REFRESH_STARTED_AT from the collector start step');
  process.exit(1);
}
const base = String(process.env.MATCHDAY_BASE_URL || 'https://matchday-odds-desk.onrender.com').replace(/\/$/, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let last = 'not checked';
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(`${base}/api/${sport}/status`, {
        headers: { 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`status HTTP ${res.status}`);
      const status = await res.json();
      const at = Date.parse(status.fetchedAt || '');
      const rows = ['winnerRows', 'totalsRows', 'setRows', 'handicapRows'].reduce(
        (total, key) => total + (Number(status[key]) || 0), 0
      );
      const fixtures = Number(status.fixtures) || 0;
      last = `fetchedAt=${status.fetchedAt || 'missing'}, fixtures=${fixtures}, marketRows=${rows}`;
      console.log(`[${sport}] persisted snapshot attempt ${attempt}: ${last}`);
      if (Number.isFinite(at) && at >= since - 1000 && fixtures > 0 && rows > 0) {
        console.log(`[${sport}] SUCCESS: fresh persisted snapshot with usable markets`);
        return;
      }
    } catch (err) {
      last = String(err.message || err);
      console.warn(`[${sport}] snapshot verification attempt ${attempt}: ${last}`);
    }
    if (attempt < 6) await sleep(5000);
  }
  throw new Error(`${sport} collector did not persist fresh, nonempty outcome rows: ${last}`);
})().catch(err => { console.error(err.message); process.exitCode = 1; });
