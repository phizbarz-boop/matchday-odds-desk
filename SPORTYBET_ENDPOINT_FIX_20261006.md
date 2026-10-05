# SportyBet real endpoint fix — 2026-10-06

## What was wrong

After the direct-scrape deploy, every SportyBet request returned
`404 {"bizCode":19001,"innerMsg":"Resource not found"}`. The browser capture
from a Nigerian network showed why: SportyBet's web API no longer uses the old
route/parameter naming.

| | Old (guessed) | Real (observed on sportybet.com) |
|---|---|---|
| Prematch list | `/factsCenter/prematchSportEvents?sport=&pageNum=` | `/factsCenter/pcUpcomingEvents?sportId=sr:sport:1&marketId=1,18,10,29,11,26,3...` |
| Sport param | `sport` | `sportId` (`sr:sport:N`) |
| Market param | none | `marketId` (CSV; the site embeds exactly those markets in the list payload) |

The observed market IDs confirm the existing football config (1=1X2, 18=O/U,
10=DC, 29=GG/NG, 11=DNB).

## What changed

- `lib/sportybetDirect.js`
  - Defaults updated: prematch `/factsCenter/pcUpcomingEvents`, live
    `/factsCenter/pcLiveEvents`, event detail `/factsCenter/eventDetail`.
  - List requests now send `sportId` + `marketId` CSV (+ `pageNum`/`pageSize`).
    All parameter names are env-overridable (`SPORTYBET_PARAM_*`).
  - **Endpoint candidate probing**: each public data route keeps a candidate
    list; the first path that answers with JSON (not a 404 gateway reply) is
    adopted and persisted with the session. A later 404 drops it and re-probes,
    so future SportyBet route renames self-heal. Probe order is overridable via
    `SPORTYBET_ENDPOINT_*_CANDIDATES`. A 10-minute negative cache stops probe
    loops when nothing answers.
  - Event detail supports `SPORTYBET_ENDPOINT_EVENT_METHOD=POST` (the site uses
    a POST "Outcomes" call for full market lists).
  - Login is never auto-probed; a 404 on login now prints a clear hint to pin
    `SPORTYBET_ENDPOINT_LOGIN` from a fresh browser capture.
  - Diagnostics now reports `resolvedEndpoints`, `endpointCandidates` and the
    active parameter names.
- `lib/sportybet.js`
  - `marketIdsForSport()` builds the per-sport market-ID CSV from the existing
    market config (+ observed extras 3/26 for football), overridable via
    `SPORTYBET_MARKET_IDS_<SPORT>`.
  - Requesting market IDs up front makes SportyBet embed those markets in the
    list payload, so most rows no longer need per-event detail calls.
  - If a specifier-specific kind (Over 1.5, Under 4.5, ...) still comes back
    empty, the bounded cached per-event detail fallback now applies to all
    markets, not only corners/team-totals/1UP.
  - `extractUpcomingEvents` gained a defensive deep search for event arrays, so
    unknown response envelopes still parse.
  - Page loops stop early when the server ignores pagination params.
- The probability model is untouched.

## Render deploy

Push the new commit, wait for the deploy, then open
`/api/sportybet/diagnostics` and confirm:

- `publicDataProbe.ok: true`
- `session.resolvedEndpoints.prematch: "/factsCenter/pcUpcomingEvents"` (or
  another resolved path — probing picks whichever answers)
- `session.loggedIn: true` once `SPORTYBET_PHONE`/`SPORTYBET_PASSWORD` are set

No proxy is needed: Render's IPs were confirmed not geo-blocked (SportyBet
answers with real JSON, not the 451 page).

Still open (need one more browser capture each, from DevTools > Network with
"Disable Cache" checked):

- exact live-board path if `pcLiveEvents` probing does not resolve (open the
  Live Betting tab and copy the events request URL)
- login path if diagnostics shows the login 404 hint
- booking create/lookup paths (`SPORTYBET_ENDPOINT_BOOK`,
  `SPORTYBET_ENDPOINT_BOOKING_LOOKUP`) if code creation fails after login works
