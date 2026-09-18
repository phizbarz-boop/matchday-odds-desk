# Daily Predictions Refresh — 07:20 AM WAT update

Changed only the core daily predictions workflow (`.github/workflows/refresh.yml`) to `20 6 * * *`, equivalent to 07:20 AM Nigeria time. Updated the matching `github.event.schedule` job condition, the server's automatic refresh time guard, and its tests.

The automatic core refresh request is accepted from 07:20 to 08:15 WAT to accommodate limited GitHub scheduling delays. This does not guarantee GitHub starts exactly on time or that the refresh successfully persists predictions.

Individual Handball, Volleyball and Tennis workflows remain at 07:05, 07:10, 07:15 WAT; Telegram remains at 08:30 WAT. No collector code or betting selection logic changed.

To activate, update GitHub's default branch (including hidden `.github/workflows`) AND redeploy the matching server code on Render. Review the workflow logs and `/api/predictions` if data remains stale.
