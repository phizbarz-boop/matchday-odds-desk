# Public SportyBet cache and next-12-hours Telegram picks

Current update: all data reads and booking-code creation are public by default. Hourly Telegram QC/live picks are removed. The cache schedule and next-12-hours picks described below remain active.

Next-12-hours tickets now scan the current public SportyBet board independently
of this cache. A missing snapshot or busy refresh cannot stop ticket scanning.
See [TELEGRAM_PUBLIC_PICKS_FIX.md](TELEGRAM_PUBLIC_PICKS_FIX.md) for the latest
installation archive and cold-cache verification.

The long Live/Quick Cash paragraph under Match Status has been removed. The
mode dropdown and its existing selection rules remain available.

Daily Prediction Refresh now collects the public SportyBet website's fixture
and event-market feeds. It does not load, attach, refresh or log in to the dummy
account, even when dummy credentials are configured on the same server.

## Automatic times

| Job | WAT times | Runs in |
| --- | --- | --- |
| Public fixture and market cache | 06:30, 12:30, 17:30 | App server |
| Six additional next-12-hours tickets | 07:00, 18:00 | App server |
| Existing SAFE daily ticket | 08:25 | Existing GitHub workflow |
| Existing result and hypothetical ₦100-per-ticket ROI reports | 00:10, 12:10 | Existing GitHub workflow |

WAT uses Africa/Lagos, UTC+1, regardless of the host's timezone. The two new
ticket batches do not wait for GitHub Actions. A restarted server can catch up
the latest ticket slot within one hour; it does not replay old morning batches.
The public-cache timer catches up the latest refresh slot on that WAT date.

## What is cached

The catalogue covers the app's six sports: Football, Basketball, Ice Hockey,
Handball, Volleyball and Tennis. It paginates the public upcoming-event lists,
then reads full event markets with at most two detail reads in parallel. It
saves fixtures, kickoff times, teams, market/outcome IDs, descriptions, lines
and offered odds. Unmodelled bet types are retained as records; ticket builders
use the app's supported probability models. Corners remain supported.

Records are saved to `data/sportybet-public-cache.json`, Redis key
`sportybet:public-catalog:v1`, and the existing football prediction snapshot.
Redis is the shared durable copy; the JSON file also supports local operation.
The normal dashboard's current football read also uses the public feeds.
Interactive Auto Analyser/live requests continue to read current markets rather
than waiting for a scheduled snapshot.

Coverage records show pages, source totals, detail failures and completeness per
sport. The default pagination limit is 50 pages of 100 events per sport, with
an optional maximum of 100 pages. This captures what SportyBet returns within
those bounds; it does not guarantee every global fixture or unsupported sport.
Partial source failures retain that sport's previous snapshot and timestamp.
Blocked/rate-limited reads or an entirely failed refresh preserve the previous
catalogue. Public collection does not fall back to account login or bypass
SportyBet verification/access restrictions.

## Six tickets per batch

Each batch requests targets of **10,000x, 2,500x, 500x, 100x A, 100x B and
100x C**, using games starting in the next rolling 12 hours. The evening window
can cross midnight; it is not restricted to today's calendar date. A one-minute
kickoff buffer excludes games that are about to start.

Selection ranks estimated combined winning probability, using the existing
SportyBet statistics model where available and complete no-vig market estimates
otherwise. The bounded combination search uses at most 40 selections, one per
match on a ticket. It considers the probability of the whole accumulator, not
just the average probability of its legs. Combined estimates assume independent
matches; offered odds and estimated probabilities do not guarantee a win or an
exact global optimum.

Within each six-ticket batch:

- Tickets have separate match IDs and bet-type IDs, including when differently
  named lines resolve to the same app bet type.
- The exception is the **identical selection** at an estimated probability of
  at least 90%: it can be shared by at most three tickets. A different outcome
  of that match does not qualify for the exception.
- The three 100x variations must have different complete selection sets, even
  when some qualifying 90% picks are shared.
- Market families are allocated among the targets before building, so the
  first large target does not consume every supported bet type.
- All selected event markets are read again anonymously before booking.
  Suspended, removed, started or changed selections are dropped. The recomputed
  odds must still reach the requested target.
- If a target is unreachable under these rules, that plan is recorded as
  unavailable. No empty or lower-target booking code is posted in its place.

Booking-code creation uses **anonymous SportyBet sharing**, just like the
public website's Book Bet button. It does not load a dummy session or fall back
to account login. The older recovery adapter remains available only with
`SPORTYBET_BOOKING_MODE=session`. No paid API-Football integration is used.
This job creates shared booking codes; it does not stake money or submit wagers.

The new codes are stored separately so they appear in Today’s Codes without
erasing SAFE or previously sent ticket history. Each sent ticket enters the existing
result tracking and ₦100-per-ticket hypothetical ROI reports. Redis checkpoints
prevent a scheduled slot or completed ticket being sent again after a restart.
Failed bookings can retry; uncertain Telegram deliveries are marked unknown
and are not automatically reposted.

## Deployment

Install this ZIP into your existing repository, commit/push, and deploy the
connected app. The deployed service has not been changed by this download.
Keep the existing persistent Redis and Telegram configuration. See
[SPORTYBET_ANONYMOUS_BOOKING.md](SPORTYBET_ANONYMOUS_BOOKING.md) for the public
booking setup. A continuously running service is required for the internal timers.

New switches default to enabled:

```text
SPORTYBET_PUBLIC_CACHE_ENABLED=true
TELEGRAM_NEXT12H_ENABLED=true
```

The new Telegram timer requires `REDIS_URL`, `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID`. Neither cache collection nor default booking requires
account credentials or browser installation.

Optional collection tuning:

```text
SPORTYBET_PUBLIC_MAX_PAGES=50
SPORTYBET_PUBLIC_DETAIL_DELAY_MS=250
```

Check `GET /api/sportybet/public-cache/status` for source/coverage/refresh times,
and `GET /api/telegram/status` for the two new slots and each target's outcome
in `next12hScheduler.lastRun.results`.

For an intentional manual cache refresh, use the **Public SportyBet Prediction
Cache** GitHub workflow or protected `POST /api/refresh` with `x-refresh-secret`.
The response acknowledges the background job; check cache status for completion.
`npm run refresh` also collects public data directly without dummy login.
Historical sport collector workflows remain manual recovery tools.

For a manual six-ticket batch at any time, use **Telegram Next 12 Hours Picks**
or `POST /api/telegram/next-12h-picks`, with `x-telegram-job-secret` and
`x-matchday-run-mode: manual`. Reusing the same `x-matchday-run-id` protects
against retries posting twice; a new ID requests a separate manual batch.
Only the app owns the new automatic schedules.

## Install on your Mac

After downloading the ZIP into Downloads:

```bash
cd ~/Documents &&
public_update_dir=$(mktemp -d /tmp/plot207-public.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-anonymous-booking.zip -d "$public_update_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$public_update_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Generate SportyBet booking codes without dummy login" &&
git push
```

Existing local secrets, data, installed dependencies and Git history are
preserved. Render must finish deploying this commit before the new timers run.

## Verification

Automated tests exercise anonymous collection with dummy credentials configured,
six-sport market storage, pagination and source failures, fresh market/probability
checks, WAT schedules, duplicate protection, the 90%/three-ticket exception,
booking/send failures and Today’s Codes. A controlled real-app integration test
refreshes at all three slots and generates six mocked booking codes at both
ticket times with no account calls. A real anonymous SportyBet share code was
also verified using the updated client. Public SportyBet reachability from your
deployed host and actual Telegram delivery must be checked after deployment.
