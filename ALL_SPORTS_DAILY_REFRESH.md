# CURRENT: unified daily predictions refresh (all six sports)

One GitHub Actions workflow: `.github/workflows/refresh.yml`.
One daily cron: `20 6 * * *` (06:20 UTC = **07:20 Nigeria/WAT**).
At that trigger, **four jobs run in parallel**, subject to GitHub runner availability:

- Football + Basketball + Ice Hockey: POST `/api/refresh`; wait until nonempty predictions with a newer `generatedAt` are saved.
- Handball: collect SportyBet fixtures and publish the Handball snapshot; verify its website status API has fresh fixtures and outcomes.
- Volleyball: collect and publish the Volleyball snapshot; verify its website status API has fresh fixtures and outcomes.
- Tennis: collect and publish the Tennis snapshot; verify its website status API has fresh fixtures and outcomes.

The three collector-specific workflows are **manual recovery only** (`workflow_dispatch`);
they have no scheduled cron. This avoids duplicate collection and duplicated API usage.
Collector failures (including snapshots with zero outcomes) now mark their individual jobs red,
while other jobs may still succeed. A green core refresh does not imply every other job succeeded.

Telegram Auto Picks remain in a separate workflow with **one daily cron at 08:25 WAT**
(`25 7 * * *` UTC). The 65-minute separation provides time but is NOT an
execution-order guarantee if GitHub jobs are delayed. The server's daily
Telegram Redis lock and schedule window are unchanged.

Requirements: GitHub secrets `REFRESH_SECRET`, `SPORTYSOCIAL_LOGIN_ID`,
`SPORTYSOCIAL_PASSWORD`, `TELEGRAM_JOB_SECRET`; corresponding Render secrets
and a configured `REDIS_URL` for persistence across instances/restarts.
Update the GitHub **default branch**, including `.github/workflows`, and deploy
updated `server.js` to Render for the Handball status endpoint correction.
Use the single Daily Predictions Refresh workflow's manual Run workflow button
for all six sports together; individual manual workflows remain for recovery.
GitHub scheduled starts are best-effort and can be delayed or occasionally missed.
