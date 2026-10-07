# Matchday Odds Desk — Direct SportyBet setup (Parse.bot removed)

SportyBet data no longer comes from the paid Parse.bot API. The server now talks
**directly to SportyBet**:

- Fixtures, markets and odds come directly from SportyBet's web JSON endpoints.
  They stay public even when dummy-account credentials are configured.
- Booking codes require your **dummy SportyBet account**. Tokens refresh
  automatically, with website-form sign-in when refresh cannot recover them.

## Render environment variables

Configure automatic session recovery once, as described in
[SPORTYBET_AUTOMATIC_SESSION.md](SPORTYBET_AUTOMATIC_SESSION.md). Set these
values privately on Render:

```text
SPORTYBET_PHONE=2348012345678
SPORTYBET_PASSWORD=your_dummy_account_password
SPORTYBET_LOGIN_METHOD=browser
PLAYWRIGHT_BROWSERS_PATH=0
```

Use Node 20 or newer, Build Command `npm ci && npm run browser:download` and
Start Command `npm start`. The included Dockerfile is an alternative if the
native runtime lacks browser system libraries. Browser recovery uses the
website's own login request; the legacy encrypted API adapter is opt-in only.
Normal token expiry no longer requires copying bootstrap cookies.

Football probabilities use SportyBet's displayed goal averages and H2H, collected
by `jobs/sporty-football-statistics-collector.js` from public match pages.
Complete offered price sets supply labelled no-vig estimates when statistics are
missing. No paid football data subscription or key is required.

Website and Telegram user requests now fetch current SportyBet fixtures/markets
and calculate selections on demand. They bypass saved daily market snapshots;
Daily Prediction Refresh now caches the public SportyBet fixture and market
feeds at 06:30, 12:30 and 17:30 WAT without dummy login. See
`PUBLIC_CACHE_AND_NEXT12H_PICKS.md` and `SPORTYBET_ON_DEMAND.md`.

The manual GitHub public-refresh workflow needs `REFRESH_SECRET`, not dummy
account or collector credentials. Keep `TELEGRAM_JOB_SECRET` the same on GitHub
and Render for protected manual Telegram jobs. Optional historical football
statistics collection still uses `node jobs/sporty-football-statistics-collector.js`
in a fresh public browser context; it is not required by `npm run refresh`.

Optional — only needed if diagnostics shows `SPORTYBET_GEO_BLOCKED`.
Reachability depends on the server IP and SportyBet's current restrictions:

```text
SPORTYBET_PROXY_URL=http://user:pass@your-nigeria-proxy:8080
```

Check `/api/sportybet/diagnostics` after deploy — a geo-block would show up
there as `SPORTYBET_GEO_BLOCKED`; only then set the proxy.

Recommended tuning (all optional):

```text
SPORTYBET_CACHE_SECONDS=43200
SPORTYBET_HOURS=120
SPORTYBET_MAX_PAGES=10
SPORTYBET_PAGE_SIZE=100
SPORTYBET_BOOKINGS_PER_MINUTE=5
H2H_MAX_WEIGHT=0.18
```

## Booking request tracking

The website submits a booking once and polls its status, allowing session recovery to finish beyond the former 18-second browser cutoff. Repeating the same request retrieves its saved result. The provider booking timeout defaults to 45 seconds. See [SPORTYBET_BOOKING_TIMEOUT_FIX.md](SPORTYBET_BOOKING_TIMEOUT_FIX.md) for deployment and retry details.

## Booking-only session recovery

Public reads do not load dummy credentials or require a session. The website does not attempt a startup login or start periodic account maintenance.

When a booking code is requested, the server loads the saved private session, verifies it and refreshes or signs in through SportyBet's own form when required. Rotated credentials are saved to Redis when configured, or the private local session file. Concurrent booking requests share verification and recovery. A failed sign-in has a cooldown and appears in booking diagnostics; public analysis remains usable.

See [SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md](SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md) for current behavior and installation. Hourly Telegram QC/live picks are removed; SAFE, next-12-hours picks and result reports remain.

## Diagnostics and manual recovery

```text
GET  /api/sportybet/diagnostics        session state, cookie expiries, proxy/geo status, public-data probe
POST /api/sportybet/session/relogin    force a fresh dummy-account login
```

Both are guarded by the website access cookie when `WEBSITE_ACCESS_CODE` is set.

## Endpoint overrides

SportyBet has renamed its internal routes before (the prematch list moved to
`pcUpcomingEvents`). The client therefore keeps a **candidate list per route
and probes it automatically**: the first path that answers with JSON is adopted
and remembered in memory for public reads, and a later 404 on that path drops
it and re-probes — route renames self-heal without a deploy. The diagnostics
endpoint shows `resolvedEndpoints` (what is in use) and `endpointCandidates`
(the probe order).

Defaults and their overrides:

```text
SPORTYBET_BASE_URL=https://www.sportybet.com/api/ng
SPORTYBET_ENDPOINT_PREMATCH=/factsCenter/pcUpcomingEvents
SPORTYBET_ENDPOINT_EVENT=/factsCenter/eventDetail
SPORTYBET_ENDPOINT_LIVE=/factsCenter/liveOrPrematchEvents
SPORTYBET_ENDPOINT_LOGIN=/patron/accessToken (default first probe)
SPORTYBET_ENDPOINT_USERINFO=/patron/account/info
SPORTYBET_ENDPOINT_BOOK=/orders/share
SPORTYBET_ENDPOINT_BOOKING_LOOKUP=/orders/share
```

The opt-in legacy API login probes routes too: SportyBet moved its account service under `/patron`
(the site's own account-info call is `/api/ng/patron/account/info`), so on
each login the app probes a small candidate list
(`/patron/accessToken`, `/users/login`,
`/patron/login`, … — extend with
`SPORTYBET_ENDPOINT_LOGIN_CANDIDATES`) and adopts the first path that answers
with anything other than the gateway's 404. The adopted path is persisted
with the session. If every candidate 404s, login backs off for
`SPORTYBET_RESOLUTION_RETRY_MS` (default 10 minutes) instead of retrying on
every booking request; pin the real path with `SPORTYBET_ENDPOINT_LOGIN` to
skip probing entirely. The booking-time account check (`SPORTYBET_ENDPOINT_USERINFO`)
resolves the same way via `SPORTYBET_ENDPOINT_USERINFO_CANDIDATES`.

List requests use the parameter naming observed on the site's own calls
(`sportId=sr:sport:1&marketId=1,18,10,29,...`). Override the names or the
market-ID CSVs only if a fresh browser capture shows they changed:

```text
SPORTYBET_PARAM_SPORT=sportId
SPORTYBET_PARAM_MARKET=marketId
SPORTYBET_PARAM_PAGE=pageNum
SPORTYBET_PARAM_PAGE_SIZE=pageSize
SPORTYBET_PARAM_EVENT_ID=eventId
SPORTYBET_MARKET_IDS_FOOTBALL=1,29,10,11,18,16,3,26
SPORTYBET_MARKET_IDS_BASKETBALL=219,223,225
SPORTYBET_MARKET_IDS_TENNIS=        (empty = omit the marketId param)
SPORTYBET_ENDPOINT_PREMATCH_CANDIDATES=/factsCenter/pcUpcomingEvents,/factsCenter/upcomingEvents,...
SPORTYBET_ENDPOINT_LIVE_CANDIDATES=/factsCenter/liveOrPrematchEvents,/factsCenter/pcLiveEvents,...
SPORTYBET_ENDPOINT_EVENT_CANDIDATES=/factsCenter/eventDetail,/factsCenter/event,...
SPORTYBET_ENDPOINT_EVENT_METHOD=GET (set to POST if the capture shows a POST "Outcomes" detail call)
```

Login probing is conservative by design (repeated failed logins could lock
the dummy account): candidates are tried only when an actual login is needed,
each candidate is POSTed once, geo/bot blocks abort probing immediately, and
a fully-failed probe round backs off for 10 minutes.

### Optional legacy API-login adapter

Only `SPORTYBET_LOGIN_METHOD=api` enables this adapter. It calls `/patron/cipher` and encrypts its payload before
posting to `/patron/accessToken`. Its default AES/CBC format has not been
verified against the current SportyBet web bundle. A generic HTTP-200 login
rejection does not prove which field or cipher is wrong. Do not repeatedly try
different cipher settings/passwords. The default `browser` method instead
uses the website form and lets SportyBet encrypt its own login request.

### Optional cookie bootstrap

If SportyBet requires human verification, you can hand the server a browser session
directly: in Firefox/Chrome DevTools → Storage/Application → Cookies →
`www.sportybet.com`, copy `accessToken`, `refreshToken` and its actual device
cookie (`device-id` or `deviceId`), and
set one env var:

```text
SPORTYBET_BOOTSTRAP_COOKIES=accessToken=...; refreshToken=...; device-id=...
```

Refresh uses `POST /api/ng/patron/refresh` while SportyBet accepts the refresh
cookie. A changed bootstrap replaces stale saved auth even if an old token is
still present; an unchanged bootstrap does not replace newer rotated tokens.
Keep `SPORTYBET_PHONE`/`SPORTYBET_PASSWORD` configured for automatic re-login
after a session is revoked. Keep the cookie values private. The local session capture helper and
recovery checks are documented in `SPORTYBET_SESSION_RECOVERY.md`.

To find the current paths: open sportybet.com/ng in a browser, open DevTools →
Network (check "Disable Cache"), log in / load a booking code / open a match,
and copy the request paths into these variables.

## Sports and markets (unchanged)

- Football: 1X2, GG/NG, Double Chance, Draw No Bet, Over 0.5, Over 1.5, Under 4.5, Asian Handicap +0/+0.25/-0.25, Corners, 1st Half Team Corners, 1UP, team totals
- Basketball: Winner incl. OT, Handicap incl. OT, Over/Under incl. OT
- Ice Hockey: Winner/1X2, Puck Line/Handicap, Over/Under Goals
- Tennis, Volleyball, Handball: Winner / Handicap / Totals — now scraped
  directly from SportyBet like the other sports (all leagues and divisions,
  `SPORTYBET_MAX_PAGES=10` default). The old collector snapshots remain as an
  automatic fallback if the direct board returns nothing.
- "Other / Special" category (opt-in per build, Elite-only on Telegram):
  football Over 2.5 / Under 2.5 (the model's o25 Poisson line; Under is its
  two-way complement on the same bookmaker market), football Correct Score
  (the model's single most likely scoreline matched to the identical
  bookmaker outcome — never a different scoreline), and Basketball / Ice
  Hockey / Handball / Volleyball two-way handicaps (no-vig market
  probability, exactly like the tennis set handicap). Website: the
  ✨ Other / Special bet types master toggle in the Auto Builder bet-type
  grid. Telegram bot: the ✨ Special Bet Types button in the Bet Types
  keyboard. The probability model itself is untouched.

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
access code) that reads the public SportyBet live board. The dummy account is
used only to create booking codes after live selections are rechecked.

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
SPORTYBET_ENDPOINT_LIVE=/factsCenter/liveOrPrematchEvents
SPORTYBET_LIVE_MAX_PAGES=5
SPORTYBET_LIVE_CACHE_SECONDS=15
SPORTYBET_LIVE_FILTER=1
```

The live board path the site actually calls is
`/api/ng/factsCenter/liveOrPrematchEvents?sportId=sr:sport:1` (observed in a
Nigerian browser, Oct 2026); the older `pcLiveEvents` guesses never answered.
As the name says, that feed can mix in-play and upcoming prematch events, so
every event passes a live filter before it becomes a `live:true` row:
explicit live flags and status text first ("1st half", "in play", …), then
kickoff time (started within the last 12 hours = live; future start =
prematch; "Not started"/"Ended" statuses are dropped regardless of kickoff).
The same filter runs again during pre-booking validation, so a prematch match
can never slip into a live-only coupon. Set `SPORTYBET_LIVE_FILTER=0` only if
a future endpoint change makes the filter hide genuinely live matches.

Live mode scans **all six sports and every supported bet type** (website and
Telegram bot alike). The scan first asks the feed to embed the configured
market IDs; the site's own live call sends only `sportId`, so if a sport comes
back with live events but zero usable markets, the scan retries once without
the `marketId` param and lets the feed return its default live markets (the
market filter itself is never loosened). When a sport still matches nothing,
the log line `[SportyBet live] <sport>: N live events scanned, 0 rows matched;
embedded live markets: …` lists exactly what the feed offered — paste it if a
sport looks missing so its live market IDs can be mapped.

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

## Live and Quick Cash

Choose `Live only (ongoing games)` to scan current SportyBet markets using your
selected bet types, minimum probability, edge, odds and selection limits.
Upcoming and finished matches are excluded. Fresh event-detail reads can find
live corner and team-total lines absent from the board's embedded markets.

`Quick Cash (late live leaders)` uses the same filters with additional rules:
football at 75+ minutes, basketball in Q4/overtime, hockey in the final
period/overtime, and handball at 50+ minutes in the second half. A readable
non-tied score is required. Picks must support the current leader in a winner,
double-chance, DNB or handicap market. Unsupported/missing phase data is skipped.
A final set cannot be inferred safely without the match format, so tennis and
volleyball are currently excluded from Quick Cash; normal Live mode supports them.

Football live probabilities use current score plus remaining time with the
SportyBet goal-rate model when all inputs exist. Missing historical inputs use
labelled, complete no-vig price sets. Live corner totals use current offered
prices rather than prematch corner expectations.

Live selections are checked against a fresh board before creating a booking
code. Changed leaders, settled matches, suspended selections and removed
markets are dropped. The Telegram Matches button also cycles through Quick
Cash; natural-language requests such as "Quick Cash 5x" select it.

This build creates SportyBet booking/share codes using the dummy account. It
uses the existing booking flow and does not submit a monetary stake.
