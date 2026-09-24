# Plot207 single daily all-sports prediction refresh — 2026-09-24

The daily prediction scheduler now follows the same reliable GitHub Actions pattern used by **SportySocial Copy Hub** and **Copy Hub Automatic Settlement**:

- one scheduled workflow;
- `workflow_dispatch` for manual recovery;
- `permissions: contents: read`;
- one concurrency group with `cancel-in-progress: false`;
- bounded job timeout;
- explicit secret checks;
- Node dependency setup + Playwright Chromium in the runner;
- synchronous/retried backend requests where appropriate;
- persisted-data verification before the workflow is considered successful;
- safe diagnostics uploaded only when the job fails.

## The only scheduled prediction workflow

`.github/workflows/refresh.yml`

Schedule: `20 6 * * *` = **07:20 WAT every day**.

It refreshes all six sports in this order:

1. Football — starts the existing Poisson + H2H refresh on Render.
2. Basketball — forces fresh SportyBet winner + totals/no-vig markets.
3. Ice Hockey — forces fresh SportyBet winner + totals/no-vig markets.
4. Handball — GitHub/Playwright collector, publishes and verifies snapshot.
5. Volleyball — GitHub/Playwright collector, publishes and verifies snapshot.
6. Tennis — GitHub/Playwright collector, publishes and verifies snapshot.
7. Football — verifies the background Football model was actually persisted.

The orchestrator is `jobs/all-sports-daily-refresh.js`.

If one sport fails, the orchestrator still attempts the remaining sports, prints a final per-sport summary, and then marks the workflow failed. This prevents one provider problem from blocking every sport.

## Individual sport workflows

The old Basketball, Ice Hockey, Handball, Volleyball, and Tennis workflows no longer contain a `schedule:` trigger. They remain available through **Run workflow** only for manual recovery/debugging. This prevents duplicate daily refreshes and duplicate SportyBet logins.

## GitHub secrets required

- `REFRESH_SECRET`
- `SPORTYSOCIAL_LOGIN_ID`
- `SPORTYSOCIAL_PASSWORD`
- `TELEGRAM_JOB_SECRET`

Optional repository variable:

- `MATCHDAY_BASE_URL`

If `MATCHDAY_BASE_URL` is empty, the orchestrator falls back to `https://matchday-odds-desk.onrender.com`.

## Telegram

Telegram Auto Picks remain separate at **08:25 WAT**. The Telegram selection rules are unchanged by this scheduler rewrite.
