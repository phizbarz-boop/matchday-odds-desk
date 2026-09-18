# Telegram Auto Pick — cancel / retry repair

## Why a cancelled GitHub run may not resend

GitHub Actions calls the Render `/api/telegram/daily-picks` endpoint. The server
creates a date-specific Redis lock *before* it starts collecting candidates.
Canceling the Actions job terminates its `curl`, but does not necessarily stop
the server handler. The original implementation could retain the Redis lock for
three days, and a repeat run reported `already_started_or_sent_today` with HTTP
200 without sending another announcement.

## Updated behavior

- If the Actions HTTP client disconnects **before the first Telegram post is
  attempted**, the server cancels its pending build and safely deletes **only
  that run's lock** using an atomic Redis compare-and-delete. An immediate
  manual retry is then allowed after the cancellation has finished processing.
- If sending has started, the daily lock is **kept**: some messages may already
  have been delivered, and another full run might post duplicate tickets.
- Concurrent attempts or attempts after a completed run respond with HTTP 409,
  code `TELEGRAM_ALREADY_STARTED_OR_SENT`, and a readable run status. A duplicate
  no longer looks like a successful Telegram run in GitHub Actions.
- Pre-post failures also release their lock and permit retry.
- Authorized read-only `GET /api/telegram/daily-picks/run-status` exposes the
  current WAT day's `locked` state and `lastRun` status. Supply the same
  `x-telegram-job-secret` request header as the GitHub workflow. The endpoint
  never reveals the Redis lock token and cannot bypass a completed run.

## Important for runs started under older deployed code

Deploying this update cannot retroactively determine whether an earlier
cancelled run already posted messages or safely remove its existing lock.
Check the Telegram channel, GitHub log and Render logs first. If the day is
already locked, do **not** indiscriminately delete the Redis key while a prior
server request may still be running. The following day's lock key is separate.

The normal daily schedule remains at 08:25 WAT (07:25 UTC), with predictions
refreshing at 07:20 WAT. The betting rules and subscription pricing are
unchanged. Changes are limited to cancellation, status diagnostics and safe
same-day retry handling.

Tests: `node --test tests/*.test.js`.
