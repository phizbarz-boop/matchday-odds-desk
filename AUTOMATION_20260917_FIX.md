**SUPERSEDED BY `AUTOMATION_20260918_ACTUAL_WORKFLOW_AND_BACKEND_FIX.md`. The September 18 patch changes the actual YAML files and adds a Redis-backed once-per-day Telegram guard.**

# Automation repair — September 17, 2026

The previous ZIP's standalone Handball, Volleyball and Tennis workflows had
only `workflow_dispatch`, so their scheduled runs were missing. The main
prediction workflow was running all three again in parallel. This patch
restores independent daily collector cron triggers and removes those duplicate
jobs from the core workflow.

| Task | Cron (UTC) | Nigeria time |
|---|---|---|
| Football, Basketball, Hockey refresh | `0 6 * * *` | 07:00 |
| Handball snapshot | `5 6 * * *` | 07:05 |
| Volleyball snapshot | `10 6 * * *` | 07:10 |
| Tennis snapshot | `15 6 * * *` | 07:15 |
| Telegram Auto Picks | `30 7 * * *` | 08:30 (once daily) |

The main refresh previously returned HTTP 200 as soon as a *background*
process was launched. GitHub could mark it green even if the actual prediction
job failed. This update polls `/api/predictions` and checks that `generatedAt`
has advanced and the refreshed dataset is nonempty. If not, the workflow fails
with a diagnostic rather than silently reporting success.

## Activate / recover

1. Commit/extract the ZIP into the repository's **default branch** (normally
   `main`), including `.github/workflows/`. A Render deploy alone does not
   change GitHub Actions schedules.
2. GitHub > Actions: verify that scheduled workflows are **enabled** and check
   the September 17 workflow history. GitHub scheduled runs may be delayed or
   occasionally dropped; YAML cannot guarantee execution at an exact minute.
3. In GitHub repository Secrets check `REFRESH_SECRET`,
   `SPORTYSOCIAL_LOGIN_ID`, `SPORTYSOCIAL_PASSWORD`, `TELEGRAM_JOB_SECRET`.
   Also ensure matching `REFRESH_SECRET` and `TELEGRAM_JOB_SECRET` exist in
   Render, along with the respective bookmaker/API secrets. Do not add secrets
   to the ZIP.
4. **For today's missed runs**, manually dispatch Daily Predictions Refresh,
   Handball, Volleyball, Tennis, then Telegram Auto Picks, in that order,
   observing each run's result. Avoid manually running the Telegram workflow
   if it already sent picks today: it does not enforce once-per-day server-side.
5. Check `/api/predictions` to see whether `generatedAt` and `matches` update.
   On Render, configure `REDIS_URL` for persistent predictions after restarts.

The selection models, daily Telegram rules, Free tier, and Copy Hub settlement
are not changed by this patch. The removed Telegram settlement workflow remains
removed.
