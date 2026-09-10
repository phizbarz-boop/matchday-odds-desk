# Daily cache + Analyzer Parse credit fix

This build makes Redis the first source of truth for SportyBet market data.

## Changes
- Adds a shared daily SportyBet snapshot per sport/market, independent of horizon/page count.
- A 7/14-day Analyzer request can reuse a broader 21-day Daily Refresh snapshot.
- Daily Predictions Refresh seeds the shared Redis snapshots for SportyBet markets it already fetched.
- Auto Builder/Telegram market cache freshness default increased to 12 hours while started fixtures are still filtered out.
- Analyzer default market scan reduced from 12 pages to 2 (configurable with ANALYZER_MAX_PAGES, capped at 4).
- Any Analyzer/Auto market fetched from Parse is immediately saved as a shared daily snapshot for later reuse.
- get_booking responses are cached in-process for 10 minutes by default to avoid repeat charges when the same code is analyzed repeatedly.

## Optional Render variables
- SPORTYBET_DAILY_SNAPSHOT_SECONDS=93600
- SPORTYBET_DAILY_SNAPSHOT_MAX_AGE_SECONDS=90000
- ANALYZER_MAX_PAGES=2
- AUTO_SPORTYBET_MAX_CACHE_AGE_SECONDS=43200
- SPORTYBET_BOOKING_LOOKUP_CACHE_SECONDS=600

The cache still removes fixtures with a confirmed kickoff in the past, so a daily snapshot does not deliberately keep already-started matches eligible.
