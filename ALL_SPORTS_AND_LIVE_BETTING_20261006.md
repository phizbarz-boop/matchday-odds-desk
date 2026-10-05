# All-sport direct scraping + live betting (2026-10-06)

## What changed

- **All six sports scraped directly from SportyBet**: football, basketball,
  tennis, ice hockey, volleyball and handball. Tennis/volleyball/handball
  joined `SPORT_CONFIG`/`SPORT_IDS` in `lib/sportybet.js` (ids are
  env-overridable, `SPORTYBET_SPORT_ID_*`). Their API route now tries the
  direct SportyBet board first and only falls back to the old collector
  snapshots when the direct board returns nothing.
- **All leagues and divisions**: prematch pagination default raised to
  `SPORTYBET_MAX_PAGES=10` (cap 20); pages are fetched until SportyBet stops
  returning rows, so no league is truncated by an arbitrary page limit.
- **Live / in-play betting**:
  - `lib/sportybetDirect.js`: new live board endpoint
    (`SPORTYBET_ENDPOINT_LIVE`, default `/factsCenter/liveSportEvents`),
    fetched with the dummy-account session attached when configured.
  - `lib/sportybet.js`: `getLiveSportMarket(sport, market)` — `market=all`
    returns every bet type offered for every live event;
    `validateLiveSelections()` re-scrapes the live board uncached before
    booking and drops suspended/settled legs instead of booking stale IDs.
    Live rows cache at most `SPORTYBET_LIVE_CACHE_SECONDS` (15s default).
  - `server.js`: `GET /api/sportybet/live/odds` and
    `POST /api/sportybet/live/book` (same rate limit + session as prematch
    booking).
  - `public/live.html`: new Live Betting page (six sports, bet-type filter,
    auto-refresh, live betslip, one-click live booking code with dropped-leg
    reporting), linked from the main dashboard header. Protected by the
    existing website access code.

## Untouched on purpose

- The probability model (Poisson + H2H), the Auto Builder logic, and the
  Telegram flows are unchanged.
- Collector snapshot jobs still run and act as fallback data.

## New tests

`tests/live-betting.test.js`: six-sport config, direct tennis scrape, live
board scrape with `market=all`, and live booking validation (suspended legs
dropped, kept legs carry refreshed odds). Full suite: 43/43 green.

## Deploy notes

Same as the Parse-removal migration: set `SPORTYBET_PHONE`,
`SPORTYBET_PASSWORD`, `SPORTYBET_PROXY_URL` (Nigeria exit), keep
`SPORTYBET_CACHE_VERSION=10`, redeploy, then confirm
`/api/sportybet/diagnostics` and open `/live.html` during a live match window.
