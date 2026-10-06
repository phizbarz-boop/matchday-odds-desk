# Parse.bot removed — direct SportyBet scraping with dummy-account session (2026-10-06)

## What changed

- `lib/sportybetDirect.js` (new): direct SportyBet web client.
  - Public fixtures/markets/odds scraping — no login needed for reading.
  - Dummy-account session manager: automatic login with
    `SPORTYBET_PHONE`/`SPORTYBET_PASSWORD`, cookie + token jar persisted to
    Redis (`sportybet:session:v1`) or `.sportybet-session.json`, keep-alive
    pings every `SPORTYBET_KEEPALIVE_SECONDS` (default 240s), silent re-login
    with single retry whenever SportyBet returns 401/403.
  - Geo-block (HTTP 451 page) and Cloudflare challenge detection with clear
    `SPORTYBET_GEO_BLOCKED` / `SPORTYBET_BOT_CHALLENGE` errors.
  - HTTP/SOCKS proxy support via `SPORTYBET_PROXY_URL` (use a Nigeria exit on
    Render; SportyBet geo-fences its API).
  - Every endpoint path overridable via `SPORTYBET_ENDPOINT_*` env vars.
- `lib/sportybet.js` (rewritten): same exported interface
  (`getFootballMarket`, `getSportMarket`, `getBooking`, `bookBet`, ...), backed
  by the direct client. The Parse credit-guard cache became a plain
  rate-politeness cache. `server.js`, jobs, Telegram and Analyzer needed no
  interface changes.
- `server.js`:
  - `PARSE_API_KEY_MISSING` error branches replaced by
    `SPORTYBET_NOT_CONFIGURED`; `PARSE_TIMEOUT` by `SPORTYBET_TIMEOUT`.
  - New guarded routes: `GET /api/sportybet/diagnostics` and
    `POST /api/sportybet/session/relogin`.
- `jobs/refresh.js`: SportyBet fixture expansion no longer gated on
  `PARSE_API_KEY`.
- `tests/team-goal-nigeria-lookup.test.js`: rewritten against the direct
  client using its injected fetch hook; added a prematch-flattening test.
- `package.json`: added `undici` (proxy-capable HTTP client).
- `PARSE_API_KEY`, `PARSE_SCRAPER_ID`, `PARSE_BOOKING_SCRAPER_ID` are no
  longer read anywhere; they can be deleted from Render.

## Required action on Render

1. Set `SPORTYBET_PHONE` + `SPORTYBET_PASSWORD` (dummy account).
2. Set `SPORTYBET_PROXY_URL` to a Nigeria-exit proxy (Render IPs are
   geo-blocked by SportyBet).
3. Bump `SPORTYBET_CACHE_VERSION=10`.
4. Redeploy, then verify `/api/sportybet/diagnostics`:
   `session.loggedIn: true`, `publicDataProbe.ok: true`.

See `SPORTYBET_SETUP.md` for the full variable list and recovery flow.
