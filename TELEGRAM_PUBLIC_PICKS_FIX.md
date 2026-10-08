# Telegram picks without waiting for the public cache

Latest update: [TELEGRAM_HOURLY_MODEL_PICKS.md](TELEGRAM_HOURLY_MODEL_PICKS.md)
adds hourly safest Live 3, QC 3 and flexible Live up to 1,000 picks without probability floors while preserving
the cache-independent SAFE and next-12-hours fix below.

This update fixes the confirmed next-12-hours failure:

```text
Public SportyBet cache is not ready
HTTP_STATUS:502
stage: building_next12h_tickets
```

The previous request-polling update kept the next-12-hours builder dependent
on the full daily catalogue. If another process held its refresh lease and no
snapshot was available, the builder received no catalogue and failed immediately.
This exact failure was reproduced using the real app and GitHub Python runner.

## Current behavior

Both Telegram pick paths scan SportyBet's current public fixture and market
feeds. The six next-12-hours targets no longer require a cache or start, wait
for, or take ownership of the daily catalogue refresh. SAFE uses the same public
scan with its existing supported market list. Public scans do not load the dummy
session, even when old dummy credentials remain configured.

The three daily catalogue refreshes still save public data for the dashboard.
An empty cache, a collecting refresh, or an expired snapshot cannot by itself
prevent these Telegram jobs from scanning current matches. A real upstream
failure still fails the job and now includes `SPORTYBET_SOURCE_UNAVAILABLE`
and the failed-feed diagnostics in both workflows.

The current-board scan shares unfinished list and detail reads and reuses
responses only within the current request. Its normal discovery and event-detail
limits apply; it does not claim complete coverage of every global fixture.
The next-12-hours scan limits fixtures to the requested horizon, and selected
markets are checked again publicly before booking.

Booking defaults to anonymous SportyBet sharing. No access-token renewal,
dummy login, paid API-Football subscription or new package is needed. This
update creates share codes and sends tickets; it does not place a funded wager.

## Retained schedules and rules

| Pick/update | WAT times | Rules |
| --- | --- | --- |
| SAFE | 08:25, GitHub Actions | Minimum 85%; odds 1.30–5.00; maximum 15 games |
| Next 12 hours | 07:00 and 18:00, app server | 10,000x, 2,500x, 500x and three 100x variations; maximum 40 games per ticket |
| Public catalogue refresh | 06:30, 12:30, 17:30, app server | Independent public collection |
| Results/ROI | 00:10 and 12:10, GitHub Actions | Existing hypothetical ₦100-per-ticket reporting |

Next-12-hours tickets retain separate matches and bet types, with the existing
three-ticket exception for identical selections at 90% or higher. Unreachable
targets and an empty eligible slate do not produce fabricated or under-target
codes. The earlier five-category hourly batch stays retired; the new three-ticket
hourly model batch is described in the latest update above. Website live/QC and the
interactive bot remain available.

The asynchronous request/status handling remains active. A repeated run ID
retrieves its saved result and does not generate duplicate bookings or messages.
Interrupted or uncertain deliveries are not automatically restarted.

## Install and run

Download `matchday-odds-desk-telegram-public-picks-fix.zip` into Downloads, then:

```bash
cd ~/Documents &&
update_dir=$(mktemp -d /tmp/matchday.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-telegram-public-picks-fix.zip -d "$update_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$update_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Run Telegram SAFE and next-12h picks directly from public SportyBet" &&
git push origin main
```

Wait for Render to finish deploying. Keep the existing Render bot token,
destination chat ID, job secret and persistent Redis configuration. Keep the
matching `TELEGRAM_JOB_SECRET` in GitHub. No cache-reset action is needed.

Start a **new** manual run with **Actions → Run workflow** for each:

- **Matchday Telegram Auto Picks**: SAFE.
- **Plot207 Telegram Next 12 Hours Picks**: six next-12-hours targets.

Do not use **Re-run jobs** on the old failed run to test this update: its same
GitHub run ID intentionally retrieves the previously saved failure. A new
workflow dispatch gets a new ID and scans the current board.

`GET /api/telegram/status` now describes the next-12-hours source as
`SportyBet current public board`, reports `cacheRequired: false`, and reports
the actual booking mode. This can distinguish the new deployment from the old
cache-dependent version.

## Verification

All 375 tests passed, with no skipped tests. Added tests run the actual Python
workflow client against the real app HTTP routes, generate six next-12-hours
codes and a SAFE code with no cache, and verify that the existing public refresh
lease is untouched. The internal 07:00 WAT slot also completes while the public
cache scheduler waits on another worker. Source failures retain useful
diagnostics instead of reporting a missing cache. Repeated workflow IDs do not
book or send again, and no dummy session is accessed.

SportyBet and Telegram responses are controlled local fixtures in these tests.
This archive has not deployed the Render service or sent a real Telegram
message. Delivery on the deployed service must be verified after installation.
