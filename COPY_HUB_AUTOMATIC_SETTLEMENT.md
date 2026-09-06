# Copy Hub automatic settlement

The Copy Hub settlement job is fully automatic through GitHub Actions.

## Schedule

`.github/workflows/copy-hub-settlement.yml` runs every 3 hours at minute 45.

It calls the protected Matchday endpoint:

`POST /api/copy/check-settlements`

using the existing GitHub repository secret `COPY_HUB_SECRET`.

## Credit-aware behavior

The backend deduplicates pending records by booking code before checking SportyBet/Parse.bot.

It avoids unnecessary status calls by:

- skipping a code while its last known fixture has not had time to finish;
- skipping older records whose first known fixture has not started;
- waiting 3 hours before rechecking a code that is still pending;
- waiting 6 hours after a temporary settlement error;
- checking at most `COPY_HUB_MAX_SETTLEMENT_CHECKS` due codes per run (default 20).

These optional Render environment variables can tune the behavior:

- `COPY_HUB_MAX_SETTLEMENT_CHECKS=20`
- `COPY_HUB_SETTLEMENT_FINISH_BUFFER_MINUTES=180`
- `COPY_HUB_SETTLEMENT_PENDING_BACKOFF_MINUTES=180`
- `COPY_HUB_SETTLEMENT_ERROR_BACKOFF_MINUTES=360`

No new secret is required.

## Result propagation

Settlement is booking-code-level. When one code is resolved as `won`, `lost`, or `push`, that status is propagated to every observed copy of the same booking code. Only the globally attributed ORIGINAL publisher receives ranking credit.

The leaderboard then recalculates automatically from the stored settlement status, updating wins, losses, win rate, unit ROI, and Copy Score.

## Manual test

GitHub → Actions → **Copy Hub Automatic Settlement** → **Run workflow**.

A normal response contains fields such as:

- `pendingFound`
- `dueFound`
- `skippedNotStarted`
- `skippedBackoff`
- `checked`
- `settled`
- `stillPending`
- `errors`
- `remainingDue`
