'use strict';

// One GitHub Actions runner orchestrates every daily prediction source.
// The structure intentionally mirrors the reliable SportySocial/Copy Hub jobs:
// one scheduled workflow, no overlapping runs, bounded retries, and all work
// completed/verified before the workflow exits.

const { spawn } = require('child_process');

const BASE_URL = String(process.env.MATCHDAY_BASE_URL || 'https://matchday-odds-desk.onrender.com').replace(/\/$/, '');
const REFRESH_SECRET = String(process.env.REFRESH_SECRET || '');
const TELEGRAM_JOB_SECRET = String(process.env.TELEGRAM_JOB_SECRET || '');
const SPORTYSOCIAL_LOGIN_ID = String(process.env.SPORTYSOCIAL_LOGIN_ID || '');
const SPORTYSOCIAL_PASSWORD = String(process.env.SPORTYSOCIAL_PASSWORD || '');
const MODE = process.env.GH_EVENT_NAME === 'workflow_dispatch' ? 'manual' : 'scheduled';
const STARTED_AT = new Date().toISOString();

const failures = [];
const summary = [];

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required environment variable/secret: ${name}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function requestJson(path, { label, timeoutMs = 650000, attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Refresh-Secret': REFRESH_SECRET,
          'x-matchday-run-mode': MODE,
        },
        body: '{}',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      const payload = safeJson(text);
      if (!response.ok) {
        const error = new Error(`${label || path} HTTP ${response.status}: ${text.slice(0, 600)}`);
        error.status = response.status;
        throw error;
      }
      console.log(`[All Sports] ${label || path} completed (HTTP ${response.status})`);
      if (text) console.log(text.slice(0, 2000));
      return payload || { ok: true, raw: text };
    } catch (error) {
      lastError = error;
      const retryable = !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
      console.warn(`[All Sports] ${label || path} attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (!retryable || attempt === attempts) break;
      await sleep(5000);
    }
  }
  throw lastError || new Error(`${label || path} failed`);
}

function runNode(script, extraEnv = {}, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    console.log(`[All Sports] node ${script}`);
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${script} timed out after ${Math.round(timeoutMs / 60000)} minutes`));
      if (code === 0) return resolve();
      reject(new Error(`${script} exited with code ${code}${signal ? ` (${signal})` : ''}`));
    });
  });
}

async function attempt(label, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    const seconds = Math.round((Date.now() - started) / 1000);
    summary.push({ label, ok: true, seconds, details });
    console.log(`[All Sports] ✅ ${label} (${seconds}s)`);
    return details;
  } catch (error) {
    const seconds = Math.round((Date.now() - started) / 1000);
    const message = String(error && error.message || error);
    failures.push({ label, message });
    summary.push({ label, ok: false, seconds, error: message });
    console.error(`[All Sports] ❌ ${label} (${seconds}s): ${message}`);
    return null;
  }
}

async function runCollector(sport, script, timeoutMinutes) {
  const collectorStartedAt = new Date().toISOString();
  await runNode(script, {
    MATCHDAY_BASE_URL: BASE_URL,
    SPORTYSOCIAL_LOGIN_ID,
    SPORTYSOCIAL_PASSWORD,
    TELEGRAM_JOB_SECRET,
  }, timeoutMinutes * 60 * 1000);
  await runNode('jobs/verify-sport-snapshot.js', {
    SPORT_NAME: sport,
    SPORT_REFRESH_STARTED_AT: collectorStartedAt,
    MATCHDAY_BASE_URL: BASE_URL,
  }, 3 * 60 * 1000);
}

(async () => {
  requireEnv('REFRESH_SECRET', REFRESH_SECRET);
  requireEnv('SPORTYSOCIAL_LOGIN_ID', SPORTYSOCIAL_LOGIN_ID);
  requireEnv('SPORTYSOCIAL_PASSWORD', SPORTYSOCIAL_PASSWORD);
  requireEnv('TELEGRAM_JOB_SECRET', TELEGRAM_JOB_SECRET);

  console.log(`[All Sports] Daily prediction refresh started`);
  console.log(`[All Sports] mode=${MODE}; startedAt=${STARTED_AT}; base=${BASE_URL}`);

  // Start Football first. The endpoint intentionally returns immediately while
  // Render computes/persists the model in the background. We verify completion
  // after the other sports, making useful use of that time instead of polling idle.
  const footballStarted = await attempt('Football: start Poisson/H2H refresh', () =>
    requestJson('/api/refresh', { label: 'Football refresh trigger', timeoutMs: 120000, attempts: 3 })
  );

  // Basketball and Hockey use the same de-margined/no-vig SportyBet market model.
  // Run them sequentially to avoid unnecessary Parse.bot concurrency/rate pressure.
  await attempt('Basketball: winner + totals market refresh', () =>
    requestJson('/api/refresh/sport/basketball', { label: 'Basketball market refresh', timeoutMs: 650000, attempts: 3 })
  );

  await attempt('Ice Hockey: winner + totals market refresh', () =>
    requestJson('/api/refresh/sport/hockey', { label: 'Ice Hockey market refresh', timeoutMs: 650000, attempts: 3 })
  );

  // Network collectors run from the GitHub runner exactly like SportySocial:
  // Chromium is installed by the workflow, each snapshot is published to Render,
  // and then verified through the public status endpoint before proceeding.
  await attempt('Handball: collect, publish, verify', () =>
    runCollector('handball', 'jobs/sporty-handball-network-collector.js', 25)
  );

  await attempt('Volleyball: collect, publish, verify', () =>
    runCollector('volleyball', 'jobs/sporty-volleyball-network-collector.js', 25)
  );

  await attempt('Tennis: collect, publish, verify', () =>
    runCollector('tennis', 'jobs/sporty-tennis-network-collector.js', 30)
  );

  if (footballStarted) {
    await attempt('Football: verify persisted predictions', () =>
      runNode('jobs/wait-for-predictions.js', {
        MATCHDAY_BASE_URL: BASE_URL,
        REFRESH_STARTED_AT: STARTED_AT,
        REFRESH_WAIT_MS: String(22 * 60 * 1000),
        REFRESH_POLL_MS: '20000',
      }, 24 * 60 * 1000)
    );
  }

  console.log('\n[All Sports] ===== FINAL SUMMARY =====');
  for (const item of summary) {
    console.log(`${item.ok ? '✅' : '❌'} ${item.label} - ${item.seconds}s${item.error ? ` - ${item.error}` : ''}`);
  }

  if (failures.length) {
    console.error(`[All Sports] Completed with ${failures.length} failed stage(s). Every sport was still attempted.`);
    process.exitCode = 1;
    return;
  }

  console.log('[All Sports] ✅ All six sports refreshed and verified successfully.');
})().catch(error => {
  console.error(`[All Sports] Fatal setup/orchestration error: ${error.message}`);
  process.exitCode = 1;
});
