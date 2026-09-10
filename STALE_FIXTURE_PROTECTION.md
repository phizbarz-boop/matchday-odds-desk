# Stale Fixture Protection

This build prevents expired or already-started SportyBet events from remaining eligible in the Auto Builder and Telegram auto picks.

## Changes
- Every SportyBet market payload is re-filtered against the current server time before it is used.
- Rows with missing/invalid kickoff times are excluded from automatic selection.
- Rows starting within the kickoff safety buffer are excluded (default: 60 seconds).
- Auto Builder/Telegram use a much shorter maximum SportyBet cache age (default: 15 minutes) even though the normal sportsbook cache can remain longer for API-credit efficiency.
- SportyBet cache version was bumped so old cached data does not survive this deployment.

## Optional environment variables
- `AUTO_SPORTYBET_MAX_CACHE_AGE_SECONDS` (default `900`)
- `SPORTYBET_KICKOFF_BUFFER_SECONDS` (default `60`)

No probability thresholds, max-selection rules, target-odds logic, red-flag rules, or supported bet markets were changed.
