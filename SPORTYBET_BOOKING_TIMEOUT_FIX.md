# SportyBet booking timeout fix

The previous website aborted its booking HTTP request after 18 seconds while the server could continue working. Booking now uses anonymous sharing by default and retains asynchronous request tracking for slow or lost connections. Account recovery applies only to explicitly configured legacy session mode. See [SPORTYBET_ANONYMOUS_BOOKING.md](SPORTYBET_ANONYMOUS_BOOKING.md).

## Current booking flow

1. Generate SportyBet Code creates a unique request ID and submits once with `Prefer: respond-async`.
2. The server accepts the request, checks live selections publicly and creates the code through anonymous SportyBet sharing. It continues independently of the first HTTP connection.
3. The website checks the read-only status URL and displays the original code, dropped-live details and sharing actions when available. It waits for up to five minutes per click. A slow or lost HTTP connection does not submit another booking.
4. If still pending, clicking Generate again or reloading the page resumes the saved request for the same slip. Completed results are kept for 24 hours and persisted to Redis when configured. Repeated submissions with the same ID retrieve the same result; changing the payload under that ID is rejected.
5. A confirmed authentication/validation failure can be retried after correction. A lost provider response has an uncertain outcome and remains attached to its original request; it is not automatically posted again. Missing records or a long-running request cannot imply a successful code.

The provider's share-code HTTP timeout defaults to 45 seconds; `SPORTYBET_BOOKING_TIMEOUT_MS` still overrides it. This is separate from the website's overall status wait. Public booking and status requests do not log in to the dummy account.

Creating the optional Send to Telegram token cannot discard an already-created booking code. If token storage fails or is slow, the SportyBet code is still returned.

Existing synchronous API clients retain the normal booking response. Both booking routes support asynchronous tracking. The status URL is `/api/sportybet/book/status/:requestId`; the random request ID is required to retrieve a result. Status responses are not cached by the browser.

## Preserved behavior

All fixtures, odds, market data, live/QC analysis, existing-code analysis, results and cache refreshes remain public SportyBet reads. Booking also defaults to anonymous sharing. Hourly QC/live Telegram picks stay removed. Website live/QC, daily SAFE, twice-daily next-12-hours picks and 12-hour results/ROI remain active.

Redis is needed to retain booking records across deployments. A worker interrupted by a deployment does not restart its provider submission; a still-pending record remains unconfirmed unless its result was persisted.

## Install

Download the updated ZIP to Downloads, then run:

```bash
cd ~/Documents &&
update_dir=$(mktemp -d /tmp/matchday.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-anonymous-booking.zip -d "$update_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$update_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Generate SportyBet booking codes without dummy login" &&
git push origin main
```

Keep the Render build command `npm ci --ignore-scripts=false` and start command `npm start`. Set `SPORTYBET_BOOKING_MODE=public` or leave it unset. After the connected deployment finishes, reload the website to load the booking client. Keep the existing Redis and Telegram settings; dummy credentials are not needed.

## Validation

All 343 Node tests passed, with no skipped tests. Syntax checks passed for 84 JavaScript files and the inline website script; all 12 workflows parsed successfully. Tests cover anonymous booking, a simulated booking beyond 18 seconds, lost HTTP responses, browser reload/resume, concurrent duplicate clicks, request-ID conflicts, Redis sharing and restart reuse, unknown provider outcomes, code retention after persistence errors, live selection checks and retained Telegram schedules. Legacy sign-in tests use local Chromium fixtures and fake credentials. Anonymous code `RF33A7` was also verified against real SportyBet through the browser and updated server client. No real account login, wager or Telegram send was performed; the Render service has not been redeployed here.
