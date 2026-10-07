# Telegram auto-pick 502 fix

The supplied GitHub log reports HTTP 502 after 57 seconds but does not include
the app's error body, so it cannot establish the deployed failure's exact cause.
The previous route kept the workflow connection open while scanning all six
sports, booking and sending. A valid empty SAFE slate also threw an exception
that became HTTP 502. Both behaviors are addressed in this update.

## Workflow behavior

SAFE and the manual next-12-hours workflow now submit once with
`Prefer: respond-async` and the GitHub workflow run ID. The app claims that ID
in Redis, replies HTTP 202 and continues the work independently of the first
connection. The workflow polls short, authenticated status requests for up to
30 minutes. A slow scan or a lost submission response does not submit another
batch. Repeating the same run retrieves its original status and result.

The log shows stages such as `scanning_sportybet`, `booking_code`,
`sending_ticket` and `building_next12h_tickets`. Confirmed failures include the
actual app error code and details. No private tokens are printed. The polling
client does not forward the job secret through HTTP redirects.

An interrupted server's unfinished job is not restarted automatically. Status
remains pending, then unknown if no final result is available. A newly dispatched
manual workflow has a new run ID and remains repeatable at any time; rerunning
the same GitHub run retrieves its earlier result.

## SAFE outcomes

- SAFE retains a minimum estimated probability of 85%, combined odds 1.30–5.00,
  a maximum of 15 games, the existing sport priorities and supported markets.
- A valid empty slate or no qualifying combination reports `no_eligible_safe_games`
  and sends the existing not-generated notice. It does not fabricate a code,
  reduce the threshold or turn that normal outcome into HTTP 502.
- If public feeds fail and leave no usable candidates, the run fails with
  `SPORTYBET_SOURCE_UNAVAILABLE` and source diagnostics.
- Booking failures are shown as booking failures. Telegram delivery failures
  are shown as delivery failures, without generating a second code or attempting
  another warning message as if booking itself had failed.
- Previous Today's Codes are not cleared when a new run produces no ticket.
  A newly generated code is saved before sending, so a delivery failure does not
  discard it. Only a complete SportyBet booking is accepted as a SAFE ticket.

Booking remains anonymous by default. No dummy login or token renewal is added.
Hourly QC/live Telegram picks remain removed. Website live/QC, public refreshes,
07:00/18:00 WAT next-12-hours targets and the result/ROI workflows remain active.

## Required settings

Keep these values privately on Render:

```text
TELEGRAM_BOT_TOKEN=<your existing auto-picks bot token>
TELEGRAM_CHAT_ID=<your existing destination>
TELEGRAM_JOB_SECRET=<your existing job secret>
REDIS_URL=<your existing persistent Redis URL>
SPORTYBET_BOOKING_MODE=public
```

GitHub needs the matching `TELEGRAM_JOB_SECRET` repository secret. The bot token,
chat ID and Redis URL are required on the app server; putting only the job
secret in GitHub does not configure Telegram delivery. Missing settings are now
reported before market scanning. Keep the same destination and existing bot
permissions. No new paid provider or package dependency is introduced.

Build command: `npm ci --ignore-scripts=false`.
Start command: `npm start`.

The workflow uses the standard Python 3 runtime on its Ubuntu runner; Render
continues to run the Node server. `MATCHDAY_BASE_URL` retains the existing Render
URL fallback and may still be set as a repository variable.

## Deploy on your Mac

Download this ZIP into Downloads, then run:

```bash
cd ~/Documents &&
update_dir=$(mktemp -d /tmp/matchday.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-telegram-auto-picks-fix.zip -d "$update_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$update_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Fix Telegram auto picks with recoverable runs and clear diagnostics" &&
git push origin main
```

Wait for Render to deploy this commit before running the workflow, because the
new workflow needs the new status routes. Reload the website after deployment.
This archive has not changed the deployed service or sent a real Telegram message.

Run **Matchday Telegram Auto Picks** manually for SAFE, or **Plot207 Telegram
Next 12 Hours Picks** for the six next-12-hours targets. Their automatic times
and the retirement of hourly picks are unchanged.

## Protected status routes

The workflow sends `x-telegram-job-secret` to all status reads:

```text
GET /api/telegram/daily-picks/run-status/<run-id>
GET /api/telegram/next-12h-picks/run-status/<run-id>
```

The original `GET /api/telegram/daily-picks/run-status` still reports the daily
scheduled lock. Status reads do not book or send messages.

## Verification

All 371 Node tests passed with no skipped tests. Syntax checks passed for 89
JavaScript files, the inline website script, the new Python runner and all 12
workflow files.

Tests exercise the actual app HTTP routes with controlled SportyBet/Telegram
responses: slow scans, connection close, duplicate requests, anonymous SAFE
booking, six next-12-hours codes, missing settings, empty slates, failed feeds,
booking rejection and delivery rejection. The workflow runner is exercised
against local HTTP fixtures, including lost submission responses, temporary
gateway errors, unknown results and redirects. Real Telegram delivery and the
deployed Render environment have not been tested from this workspace.
