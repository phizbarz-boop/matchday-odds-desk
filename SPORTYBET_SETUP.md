# Matchday Odds Desk — Direct SportyBet setup (Parse.bot removed)

SportyBet data no longer comes from the paid Parse.bot API. The server now talks
**directly to SportyBet**:

- Fixtures, markets and odds are scraped from SportyBet's own public web JSON
  endpoints. No account and no API key are needed for reading data.
- Booking-code creation logs in with your **dummy SportyBet account**. The
  session is kept alive automatically (see below).

## Render environment variables

Required for booking codes (the dummy account):

```text
SPORTYBET_PHONE=2348012345678
SPORTYBET_PASSWORD=your_dummy_account_password
```

Required for the probability model (unchanged):

```text
FOOTBALL_DATA_TOKEN=your_football_data_token
```

Strongly recommended — SportyBet geo-blocks non-allowed server IPs (Render
US/EU included). Point this at an HTTP or SOCKS5 proxy with a Nigerian exit:

```text
SPORTYBET_PROXY_URL=http://user:pass@your-nigeria-proxy:8080
```

If SportyBet answers this server's IP directly you can omit the proxy; check
`/api/sportybet/diagnostics` after deploy — a geo-block shows up there as
`SPORTYBET_GEO_BLOCKED`.

Recommended tuning (all optional):

```text
SPORTYBET_CACHE_SECONDS=43200
SPORTYBET_HOURS=120
SPORTYBET_MAX_PAGES=10
SPORTYBET_PAGE_SIZE=100
SPORTYBET_BOOKINGS_PER_MINUTE=5
SPORTYBET_KEEPALIVE_SECONDS=240
H2H_PREVIOUS_SEASONS=1
H2H_MAX_MEETINGS=8
H2H_MAX_WEIGHT=0.18
```

## How the session is kept alive

1. On boot (and before the first booking) the server logs in the dummy account
   with `SPORTYBET_PHONE` / `SPORTYBET_PASSWORD`.
2. Cookies and the access token are persisted to Redis when `REDIS_URL` is set
   (recommended on Render, where the filesystem is wiped on every deploy),
   otherwise to `.sportybet-session.json`.
3. A keep-alive ping runs every `SPORTYBET_KEEPALIVE_SECONDS` (default 240s),
   refreshing cookies before they die.
4. If SportyBet still invalidates the session server-side, the next request
   gets a 401/403, the client **re-logs in silently** and retries once.

Honest limit: no client can stop SportyBet from expiring sessions server-side.
What this build guarantees is detection + automatic recovery, so expiry is
never visible to users. If the account ever demands an SMS OTP at login,
automatic renewal stops and diagnostics will say so — log in once from a
browser on the same IP/proxy to clear it.

## Diagnostics and manual recovery

```text
GET  /api/sportybet/diagnostics        session state, cookie expiries, proxy/geo status, public-data probe
POST /api/sportybet/session/relogin    force a fresh dummy-account login
```

Both are guarded by the website access cookie when `WEBSITE_ACCESS_CODE` is set.

## Endpoint overrides

SportyBet can rename its internal routes. Every path is an environment
variable, so a route change never needs a code deploy:

```text
SPORTYBET_BASE_URL=https://www.sportybet.com/api/ng
SPORTYBET_ENDPOINT_PREMATCH=/factsCenter/prematchSportEvents
SPORTYBET_ENDPOINT_EVENT=/factsCenter/event
SPORTYBET_ENDPOINT_LOGIN=/users/login
SPORTYBET_ENDPOINT_USERINFO=/users/info
SPORTYBET_ENDPOINT_BOOK=/orders/share
SPORTYBET_ENDPOINT_BOOKING_LOOKUP=/orders/share
SPORTYBET_ENDPOINT_LIVE=/factsCenter/liveSportEvents
```

To find the current paths: open sportybet.com/ng in a browser, open DevTools →
Network, log in / load a booking code / open a match, and copy the request
paths into these variables.

## Sports and markets (unchanged)

- Football: 1X2, GG/NG, Double Chance, Draw No Bet, Over 0.5, Over 1.5, Under 4.5, Asian Handicap +0/+0.25/-0.25, Corners, 1st Half Team Corners, 1UP, team totals
- Basketball: Winner incl. OT, Handicap incl. OT, Over/Under incl. OT
- Ice Hockey: Winner/1X2, Puck Line/Handicap, Over/Under Goals
- Tennis, Volleyball, Handball: Winner / Handicap / Totals — now scraped
  directly from SportyBet like the other sports (all leagues and divisions,
  `SPORTYBET_MAX_PAGES=10` default). The old collector snapshots remain as an
  automatic fallback if the direct board returns nothing.
- O/U 2.5 is intentionally excluded from the Auto Builder. The probability
  model is untouched.

Sport id overrides if SportyBet renumbers:

```text
SPORTYBET_SPORT_ID_FOOTBALL=sr:sport:1
SPORTYBET_SPORT_ID_BASKETBALL=sr:sport:2
SPORTYBET_SPORT_ID_HOCKEY=sr:sport:4
SPORTYBET_SPORT_ID_TENNIS=sr:sport:5
SPORTYBET_SPORT_ID_HANDBALL=sr:sport:6
SPORTYBET_SPORT_ID_VOLLEYBALL=sr:sport:23
```

## Live / in-play betting

The site has a **Live Betting** page (`/live.html`, behind the same website
access code) that scrapes the SportyBet live board through the dummy-account
session and creates booking codes for live selections only.

```text
GET  /api/sportybet/live/odds?sport=football&market=all
POST /api/sportybet/live/book     { "selections": [...] }
```

- `market=all` returns every bet type offered for every live event; per-sport
  filters work too (e.g. `sport=football&market=1x2`).
- Live rows are cached at most `SPORTYBET_LIVE_CACHE_SECONDS` (default 15s).
- Before a live code is created, every leg is re-validated against a **fresh,
  uncached** live board scrape. Suspended or settled legs are dropped and
  reported in `dropped`; they are never booked blindly.
- Live booking uses the same dummy-account session and per-minute rate limit
  as prematch booking.

Live tuning:

```text
SPORTYBET_ENDPOINT_LIVE=/factsCenter/liveSportEvents
SPORTYBET_LIVE_MAX_PAGES=5
SPORTYBET_LIVE_CACHE_SECONDS=15
```

## API routes (unchanged interface)

```text
GET  /api/sportybet/odds?market=1x2|gg|dc|dnb|ou05|ou15|ou45|ah|oneup|corners|first_half_team_corners
GET  /api/sportybet/sport/basketball?market=winner|handicap|totals
GET  /api/sportybet/sport/hockey?market=winner|handicap|totals
POST /api/sportybet/book
POST /api/sportybet/auto-pick
POST /api/sportybet/analyze-code
POST /api/sportybet/replace-unsupported
```

## Booking code creation

`POST /api/sportybet/book` now books through the dummy-account session instead
of Parse. Every selectable outcome still carries its real SportyBet
`eventId`, `marketId`, `outcomeId` and optional `specifier`; no IDs are ever
invented. The account is never used to stake real money — only "book a bet"
share-code creation is called.

## Risk notes

- Automated traffic on a logged-in account can get that account flagged or
  banned by SportyBet's risk systems, and this usage is against their terms.
  Use a throwaway dummy account only, keep `SPORTYBET_BOOKINGS_PER_MINUTE`
  low, and never reuse an account you care about.
- Reading odds is anonymous; only booking touches the account.

## Deploy

Commit to the GitHub repository connected to Render, set the environment
variables above, redeploy, then open `/api/sportybet/diagnostics` and confirm
`session.loggedIn: true` and `publicDataProbe.ok: true`. Run one
`Daily Predictions Refresh` after deploying.

Bump `SPORTYBET_CACHE_VERSION` (e.g. to `10`) on first deploy so no stale
Parse-era cache entries are reused.
