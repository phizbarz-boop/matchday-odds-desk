# Daily automation: accept delayed GitHub runs

- The single all-six-sports Daily Predictions Refresh workflow is scheduled at `20 6 * * *` UTC (07:20 WAT). Its four sport jobs launch in parallel, and the existing snapshot checks remain active.
- The Telegram Auto Picks workflow is scheduled at `25 7 * * *` UTC (08:25 WAT), once per day.
- Neither API endpoint rejects an authenticated request for arriving outside a time window. GitHub Actions may delay or skip scheduled starts; this change removes the application-side cause of HTTP 409 WRONG_TIME failures but cannot force GitHub to dispatch a missed job.
- Telegram retains its Redis once-per-Nigeria-day lock to prevent duplicate announcements. Running a manual workflow after picks have already posted will still return an explicit duplicate status. A cancelled run before posting may retry under the existing cancellation handling.
- To activate, commit `.github/workflows` to the GitHub default branch AND deploy updated `server.js` to Render. Check for other Render Cron or legacy workflows if duplicate initiations continue.
- The website showing zero outcomes after successful collector runs is a separate data publication/storage issue, not proof of incorrect cron conversion.
