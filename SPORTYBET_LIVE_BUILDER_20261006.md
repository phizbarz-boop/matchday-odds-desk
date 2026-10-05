# Live matches in the Auto Builder + daily snapshot seeding (2026-10-06)

## What you asked for

1. **No separate live-betting page** — live matches are an option inside the
   Auto Builder, scored by your existing probability model (model untouched).
2. **Cache matches once the daily prediction refresh runs** so the server
   stops calling SportyBet repeatedly and builds are fast.
3. **All of it in the Telegram bot too**, including an opt-in for live
   ongoing games in the auto analyzer.

## What changed

### Live as an Auto Builder option

- `public/live.html` was **deleted**; the header link is gone. Live now lives
  inside the Auto Builder as a *Match status* selector:
  `Prematch only (daily cache)` (default), `🔴 Live only (ongoing games)`,
  `Prematch + 🔴 Live`. The choice travels as `liveMode`
  (`prematch` | `live` | `both`) through `/api/sportybet/auto-pick`.
- Live rows share the exact prematch candidate shape (tagged `live: true`),
  so the existing candidate generators and the Poisson + H2H probability
  model score them unchanged. Football live legs reuse the saved daily
  predictions (kept until the next 07:20 WAT refresh even after kickoff);
  other sports use no-vig market probabilities.
- Slip items show a `🔴 LIVE` badge.

### Booking safety for live legs

- Immediately before a booking code is created (website *Generate Code* and
  Telegram bot), every live leg is re-validated against a **fresh, uncached**
  live board. Suspended/settled legs are dropped and reported as
  `droppedLive`; the code is created from what remains (409 if nothing
  remains). If the live board can't be checked, live legs are never booked
  blindly — they're dropped or the request fails with
  `LIVE_VALIDATION_UNAVAILABLE`.

### Daily snapshot seeding (speed)

- `jobs/refresh.js` now writes SportyBet market snapshots for **every market
  the Auto Builder uses across all six sports** after each daily refresh
  (football 1x2/GG/DC/DNB/OU0.5/OU1.5/OU4.5/AH/corners/first-half corners/
  team goals; basketball/hockey/handball/volleyball/tennis winner, totals,
  handicap/sets).
- Snapshots go to Redis when configured and **always to
  `data/sporty-snapshots/*.json`** — the refresh job runs as a separate
  process from the web server, so the files are the shared fallback.
- Auto Builder / Analyzer / Telegram prematch builds read from these
  snapshots instead of re-fetching SportyBet on every request. Live legs
  always bypass the cache (in-play odds move too fast).
- New env vars: `SPORTYBET_SNAPSHOT_SEED` (`1` default; `0` disables
  seeding), `SPORTYBET_SNAPSHOT_DIR`, `DAILY_SPORT_REFRESH_MAX_PAGES`.

### Telegram bot parity

- Auto Builder keyboard: new *Matches* button cycling
  `PREMATCH → LIVE ONLY → LIVE + PREMATCH`; the builder summary shows the
  current mode.
- Natural language + LLM ticket requests understand "live 5x", "in-play",
  "ongoing games", "live and prematch" (new `liveMode` field in the LLM
  schema).
- Tickets show a mode header (`🔴 LIVE ONLY` / `PREMATCH + 🔴 LIVE`), mark
  live legs `🔴 LIVE`, and list any dropped live selections.
- Booking Code Analyzer: new *Live Games: ON/OFF* opt-in button
  (`includeLive`) — when ON, ongoing in-play games are also scored when
  replacing unsupported legs. Re-replacement of the last analysis keeps the
  setting.

### Internal endpoints

`/api/sportybet/live/odds` and `/api/sportybet/live/book` remain available
as internal JSON endpoints but are no longer linked from any page.

## Deploy

Push to GitHub; Render redeploys automatically. No new required env vars —
defaults are sensible. After deploy, run one **Daily Predictions Refresh**
so the snapshots get seeded, then Auto Builder builds are instant.

Set `SPORTYBET_SNAPSHOT_SEED=0` if you ever want the refresh job to skip the
SportyBet seeding pass.
