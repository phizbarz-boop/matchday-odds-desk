# SportyBet on-demand requests

All request reads are public. Dummy authentication starts only when creating a booking code. Hourly Telegram QC/live picks are removed; see [SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md](SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md). Website live/QC selection rules remain active.

Auto Analyser, manual market views, booking-code analysis and same-fixture replacements now read current SportyBet data when requested. This applies to website visitors and the Telegram builder/analyser. No daily prediction refresh is required before a user can build or analyse a slip.

## Request flow

1. Read the current prematch/live board for the selected sports and supported bet types.
2. Exclude started prematch fixtures, finished live games, banned events, suspended/settled markets and inactive outcomes.
3. Calculate football probabilities using available SportyBet goal/H2H statistics. When historical statistics are missing, use complete offered price sets for clearly labelled margin-adjusted estimates. Other sports use the existing market-estimate model.
4. Apply the user's probability, edge, sport, league, match-status and odds settings; select the slip and generate a booking/share code when requested.

Live and Quick Cash retain the fresh pre-booking checks. No monetary wagers are submitted by this app.

Booking-code analysis reads the exact event IDs on the submitted ticket. It does not depend on those games appearing in a saved prediction list or the first page of upcoming events. Replacements stay on the same fixture and use currently offered market/outcome IDs.

## What Daily Prediction Refresh still does

The app now collects public SportyBet upcoming fixtures and full event markets for all six supported sports at 06:30, 12:30 and 17:30 WAT, saving the catalogue and football prediction snapshot without dummy login. Six extra next-12-hours Telegram targets run at 07:00 and 18:00 WAT. SAFE and 12-hour result/ROI jobs continue. See `PUBLIC_CACHE_AND_NEXT12H_PICKS.md` for data, selection and delivery rules. Historical collectors remain optional manual tools; user requests work independently of the cache schedule.

The website football dashboard requests `/api/predictions?source=current`. The default `/api/predictions` still exposes the saved daily snapshot so workflow completion checks remain meaningful.

## Freshness and coverage

- User requests bypass completed daily, Redis, file and process market caches. They add a current-read parameter to SportyBet GET requests.
- Market families share reads within one request. Concurrent users share only unfinished upstream reads; a later request performs a new read.
- A failed upstream read does not restore old games/prices as current data. Auto Analyser exposes the source error.
- Current prematch pagination uses SportyBet's `totalNum`. Existing horizon/page limits still bound board discovery: `SPORTYBET_HOURS`, `SPORTYBET_MAX_PAGES` (default 10, maximum 20), and `SPORTYBET_PAGE_SIZE` (default 100). The user sees the supported markets found within that scan.
- Historical statistics retain their own capture time and age limit. A missing/unreachable statistics store cannot block current market estimates; its optional read is bounded by `SPORTYBET_STATS_READ_TIMEOUT_MS` (default 2000).
- Games and prices update when requested. SportyBet can change availability before code generation, so live selections are checked again.

## Install and validate

Deploy the updated source using the existing server settings. No new required environment variables or paid data key are needed. Keep the dummy SportyBet credentials for creating booking/share codes.

The current update passed all 332 Node regression tests, including public reads with dummy credentials configured and booking-time session recovery. Integration tests use local fixtures and mocked SportyBet booking responses; this update does not verify production account authentication.
