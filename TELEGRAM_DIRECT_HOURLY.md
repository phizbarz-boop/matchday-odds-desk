# Direct hourly SportyBet tickets to Telegram

> Historical instructions for the earlier hourly batch. For the current safest Live 3, QC 3, and flexible Live up to 1,000 picks without probability floors, see [TELEGRAM_HOURLY_MODEL_PICKS.md](TELEGRAM_HOURLY_MODEL_PICKS.md).

> Current update: hourly Telegram QC/live generation and its workflow are removed. Website live/QC, SAFE, next-12-hours picks and result reports remain. This earlier guide records the previous hourly implementation. See [SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md](SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md).

The app now runs the hourly QC/live batch itself. Its timer calls the booking
job directly inside the Node server, reads current SportyBet live pages using
the dummy account, rechecks each selected market, creates booking codes and
sends them to the configured Telegram chat. No GitHub workflow or HTTP request
is required to start an automatic hourly run.

| Automatic hourly ticket | Minimum probability |
| --- | --- |
| QC ICE HOCKEY | 0% |
| QC BASKETBALL | 0% |
| QC HANDBALL + VOLLEYBALL | 0% |
| QC FOOTBALL | 0% |
| LIVE ALL SPORTS | 85% |

All live selections must be ongoing, at least halfway through the match and
currently winning for the actual SportyBet market/line. QC additionally requires
its late stage. The selection rules and flexible odds goals are described in
[TELEGRAM_HOURLY_SPORT_QC_AND_ROI.md](TELEGRAM_HOURLY_SPORT_QC_AND_ROI.md).
Every eligible category is attempted; an empty category cannot produce a code.
No monetary wager is placed by this booking-code workflow.

## Activate on the server

Install this source, commit/push it, and wait for the connected Render service
to deploy. The existing `npm start` command starts the website and hourly timer.
Keep these settings on the server:

```text
REDIS_URL=<existing Redis connection>
TELEGRAM_BOT_TOKEN=<existing bot token>
TELEGRAM_CHAT_ID=<existing destination>
TELEGRAM_HOURLY_ENABLED=true
TELEGRAM_HOURLY_MINUTE=5
```

`TELEGRAM_HOURLY_ENABLED` defaults to `true`; `TELEGRAM_HOURLY_MINUTE` defaults to
`5`. Set the minute to `0` if you prefer the beginning of each WAT hour. Valid
minutes are 0–59. Environment changes require a server restart/redeploy.
Set `TELEGRAM_HOURLY_ENABLED=false` to stop automatic hourly picks while keeping
authenticated manual runs available.

Set `SPORTYBET_PHONE` and `SPORTYBET_PASSWORD` and install Chromium once for
automatic dummy-account login and renewal, following
[SPORTYBET_AUTOMATIC_SESSION.md](SPORTYBET_AUTOMATIC_SESSION.md). The hourly
job uses that same recovered session; visitor/device cookies cannot substitute
for authenticated access. Normal expiry no longer requires copied cookies.
Unrecoverable source errors remain visible and retry through the existing job.

The timer needs an **always-running Node service**. Render Free web services
sleep after 15 minutes without inbound HTTP/WebSocket traffic. An internal
timer and outgoing SportyBet/Telegram requests do not provide that inbound
traffic. Use an always-on web-service compute instance or another continuously
running host for reliable hourly delivery. Changing a Render workspace plan
alone does not remove Free compute's sleeping behavior. See
[Render's Free service documentation](https://render.com/docs/free).

Use Redis storage that retains its data through restarts for reliable booking
history, result tracking and duplicate protection. Render Free Key Value loses
its data on restart; clearing these records also clears the stored run locks.
No self-ping service or new hosting subscription is configured by this source.

## Timing, recovery and duplicate protection

- The timer checks every 30 seconds and starts at the configured WAT minute each
  hour. Data reads, validation and booking take additional time before delivery.
- Startup after the due minute attempts the current hour immediately. A startup
  before it waits for the current hour's configured minute. It never reconstructs
  missed historical live tickets from old scores.
- All server instances and the scheduled compatibility endpoint share Redis
  hour/category locks. A completed or ambiguous delivery cannot be posted again
  in that hour while those locks remain stored.
- Unsent source or booking failures retry after two minutes. A partially sent
  batch retries its unsent categories; completed and ambiguous categories remain
  protected. A healthy run with no eligible games finishes that hour's scan.
- Each run has a 13-minute deadline. Shutdown or a deadline cancels further
  posting. A stale hourly run cannot start a new Telegram post in a later hour.
  Already-started sends can remain ambiguous and retain their protective locks.
- Restarting after a completed hourly run reads the shared lock and skips it.
  In-progress/ambiguous locks are preserved rather than force-unlocked; a new
  hour gets its own scope.

## Verify direct delivery

Render logs show:

```text
[Telegram hourly direct] active at :05 each hour WAT; current-hour catch-up enabled
[Telegram hourly direct] 2026-10-06T17 completed; sent=5
```

The count depends on currently eligible live games. Missing Telegram/Redis
settings produce an explicit disabled log with the missing setting names.
Source failures log their reason and show retry status.

`GET /api/telegram/status` reports `hourlyScheduler.source: "app-server"`,
`running`, `busy`, `nextRunAt`, missing settings and the last local batch's
category outcomes. The response contains no credentials. For the shared current
hour's status across instances, use the protected endpoint:

```bash
curl --fail-with-body --silent --show-error \
  'https://matchday-odds-desk.onrender.com/api/telegram/quick-cash/run-status' \
  -H 'x-telegram-job-secret: YOUR_TELEGRAM_JOB_SECRET'
```

It shows the shared hour lock, batch status and each category's completed,
no-eligible, failed or unknown-delivery state. It does not expose lock-owner
tokens or provide a force-unlock action.

## Manual runs, Today’s Codes and other schedules

The hourly GitHub workflow is now **manual-only**. Automatic hourly picks no
longer depend on GitHub scheduler starts. A manual **Matchday Telegram Auto
Picks** run still requests SAFE followed by all five hourly categories at any
time. A new manual hourly run can also request fresh codes in the same hour,
using an independent scope and stable retry ID. See
[TELEGRAM_MANUAL_ALL_PICKS.md](TELEGRAM_MANUAL_ALL_PICKS.md).

Hourly and manual codes remain separate entries in Today’s Codes and ticket
tracking. Morning SAFE at 08:25 WAT and the 12-hour results/₦100 ROI reports at
00:10/12:10 WAT retain their existing GitHub workflows. Moving the hourly clock
does not alter the report's confirmed-result calculations.

## Validation

All 258 Node tests pass. Syntax checks pass for 68 JavaScript files and the
inline website script; all three Telegram workflows and daily refresh parse, and
`git diff --check` passes.

The direct scheduler is tested with a controlled clock, mocked upstream
services and the real application HTTP handlers. Tests prove that server startup
alone creates all five eligible tickets, a later hour creates five fresh codes,
scheduled HTTP retries cannot duplicate those sends, and manual batches remain
independent. They also check concurrent instances, restart deduplication,
configuration, retries, shutdown, time limits, WAT day boundaries, Today’s Codes
history and ₦100-per-sent-ticket tracking.

Production credentials, real Telegram delivery and the deployed Render service
are not exercised by these tests. This archive must be installed and deployed.
