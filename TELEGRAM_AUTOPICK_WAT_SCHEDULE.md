# Telegram Auto Pick schedule (Nigeria/WAT)

The automatic Telegram Auto Picks run **once per day at 08:25 WAT**.
GitHub Actions cron is in UTC: `25 7 * * *` = 07:25 UTC = 08:25 WAT.

- Core Daily Predictions Refresh: 07:20 WAT (`20 6 * * *` UTC).
- Telegram Auto Picks: 08:25 WAT (`25 7 * * *` UTC).
- The server rejects automatic Telegram requests outside 08:25–09:25 WAT and uses a shared Redis daily lock to prevent duplicate posts. This grace window is not an extra scheduled run.
- GitHub Actions manual `workflow_dispatch` remains available for authorized recovery, subject to the daily duplicate-post lock.

Commit `.github/workflows/telegram-picks.yml` to the GitHub default branch **and** deploy the updated `lib/dailyScheduleGuard.js` and `server.js` to Render. Scheduled jobs may be delayed by GitHub.
