# SportyBet booking timeout fix

The previous website aborted its booking HTTP request after 18 seconds. Booking can first require public live checks, restoring a persisted session, refreshing it or browser sign-in. The server could continue working after that browser cutoff. The supplied log ends at session restore and does not show a confirmed booking response.

## Current booking flow

1. Generate SportyBet Code creates a unique request ID and submits once with `Prefer: respond-async`.
2. The server accepts the request, checks live selections publicly and uses the dummy account only to create the booking code. It continues independently of the first HTTP connection.
3. The website checks the read-only status URL and displays the original code, dropped-live details and sharing actions when available. It waits for up to five minutes per click. A slow or lost HTTP connection does not submit another booking.
4. If still pending, clicking Generate again or reloading the page resumes the saved request for the same slip. Completed results are kept for 24 hours and persisted to Redis when configured. Repeated submissions with the same ID retrieve the same result; changing the payload under that ID is rejected.
5. A confirmed authentication/validation failure can be retried after correction. A lost provider response has an uncertain outcome and remains attached to its original request; it is not automatically posted again. Missing records or a long-running request cannot imply a successful code.

The provider's share-code HTTP timeout defaults to 45 seconds; `SPORTYBET_BOOKING_TIMEOUT_MS` still overrides it. This is separate from session recovery and the website's overall status wait. Status requests do not log in to the dummy account.

Creating the optional Send to Telegram token cannot discard an already-created booking code. If token storage fails or is slow, the SportyBet code is still returned.

Existing synchronous API clients retain the normal booking response. Both booking routes support asynchronous tracking. The status URL is `/api/sportybet/book/status/:requestId`; the random request ID is required to retrieve a result. Status responses are not cached by the browser.

## Preserved behavior

All fixtures, odds, market data, live/QC analysis, existing-code analysis, results and cache refreshes remain public SportyBet reads. Dummy login and renewal remain booking-only. Hourly QC/live Telegram picks stay removed. Website live/QC, daily SAFE, twice-daily next-12-hours picks and 12-hour results/ROI remain active.

Redis is needed to retain booking records across deployments. A worker interrupted by a deployment does not restart its provider submission; a still-pending record remains unconfirmed unless its result was persisted.

## Install

Download the updated ZIP to Downloads, then run:

```bash
cd ~/Documents &&
update_dir=$(mktemp -d /tmp/matchday.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-booking-timeout-fix.zip -d "$update_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$update_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Fix booking timeout with recoverable booking requests" &&
git push origin main
```

Keep the Render build command `npm ci --ignore-scripts=false` and start command `npm start`. After the connected deployment finishes, reload the website to load the new booking client. Keep the existing private account, Redis and Telegram settings.

## Validation

All 332 Node tests passed, with no skipped tests. Syntax checks passed for 84 JavaScript files and the inline website script; all 12 workflows parsed successfully. Tests cover a simulated booking beyond 18 seconds, lost HTTP responses, browser reload/resume, concurrent duplicate clicks, request-ID conflicts, Redis sharing and restart reuse, unknown provider outcomes, cached authentication errors, code retention after persistence errors, delayed login/booking through the actual HTTP routes, public reads during booking recovery, live selection checks and the retained Telegram schedules. Real Chromium sign-in tests use local fixtures and fake credentials. No real SportyBet account login, booking or Telegram send was performed for this update.
