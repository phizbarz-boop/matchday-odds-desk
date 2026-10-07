# Telegram booking-code setup

The server creates codes directly through the authenticated dummy SportyBet
account and sends them to your configured Telegram chat. Hourly QC/live picks
run inside the application; they do not depend on GitHub's hourly scheduler.

| Ticket/update | Time in WAT | Scheduler |
| --- | --- | --- |
| QC Ice Hockey, Basketball, Handball + Volleyball, Football; 0% minimum | Every hour at :05 by default | App server |
| Live All Sports; 85% minimum | Same hourly batch | App server |
| SAFE; 85%, combined odds 1.30–5.00 | 08:25 daily | GitHub Actions |
| Results, closest/worst tickets and hypothetical ₦100 ROI | 00:10 and 12:10 | GitHub Actions |

See [TELEGRAM_DIRECT_HOURLY.md](TELEGRAM_DIRECT_HOURLY.md) for direct scheduling
and [TELEGRAM_HOURLY_SPORT_QC_AND_ROI.md](TELEGRAM_HOURLY_SPORT_QC_AND_ROI.md)
for selection rules and reports.

## Bot and destination

If you already configured your Telegram bot/chat, retain those settings.
Otherwise create a bot with Telegram's **@BotFather**, keep its token private,
and start a conversation with it. Obtain your chat ID using the bot's
`getUpdates` response. For a channel, add the bot with permission to post and
use its channel ID or supported `@channelusername`.

## Server environment

Keep these variables on Render or the host running `npm start`:

```text
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your chat/channel ID>
REDIS_URL=<your persistent Redis connection>
TELEGRAM_JOB_SECRET=<your existing job secret>
TELEGRAM_HOURLY_ENABLED=true
TELEGRAM_HOURLY_MINUTE=5
```

The hourly enable/minute settings are optional with these defaults. Use minute
`0` for the beginning of each hour, or `TELEGRAM_HOURLY_ENABLED=false` to disable
automatic hourly picks. The direct timer requires Redis and Telegram settings;
its internal job does not transmit or require the GitHub job secret. Keep the
job secret for protected status/manual APIs, morning SAFE and results workflows.

Retain a working dummy-account session/login configuration. Session setup and
automatic renewal are in [SPORTYBET_AUTOMATIC_SESSION.md](SPORTYBET_AUTOMATIC_SESSION.md).
Never put session cookies or Telegram tokens in the committed source.

The server must stay running between hourly runs. Render Free web services
sleep after 15 minutes without inbound traffic, so they cannot reliably run an
internal hourly timer while idle. Use an always-on service for automatic hourly
delivery. See [Render's documentation](https://render.com/docs/free). Persistent
Redis is also needed to retain locks, codes and tracking through restarts.

Optional odds/cap settings:

```text
TELEGRAM_QC_TARGET_ODDS=2
TELEGRAM_QC_MAX_SELECTIONS=15
TELEGRAM_LIVE_TARGET_ODDS=2
TELEGRAM_LIVE_MAX_SELECTIONS=15
```

Targets are flexible: a qualifying selection at 10 odds can produce a 10-odds
code. The hourly probability floors remain fixed at QC 0% and Live 85%.
Match stage, currently-winning selection and market availability still apply.

## Deployment and verification

Commit/push the installed source and wait for the connected server deployment.
The existing `npm start` runs both the website and hourly timer. Check Render
logs for `[Telegram hourly direct] active` and use:

```text
GET /api/telegram/status
```

The `hourlyScheduler` section shows whether the direct timer is running, missing
configuration, its next attempt and last batch outcomes. Check shared hourly
state with `GET /api/telegram/quick-cash/run-status`, authenticated by the
`x-telegram-job-secret` header.

Keep the same `TELEGRAM_JOB_SECRET` in GitHub Actions secrets for the retained
morning/report workflows and manual triggers. `MATCHDAY_BASE_URL` can be a
repository variable; the existing Render URL is the fallback. Your bot token
and chat ID stay on the server.

## Manual picks at any time

**Matchday Telegram Auto Picks → Run workflow** requests SAFE and then all five
hourly categories, including when SAFE fails. **Plot207 Telegram Hourly QC and
Live Picks → Run workflow** requests only the five current live categories.
The latter workflow is manual-only; automatic hourly delivery comes from the
server timer.

A new manual run can produce fresh eligible codes in an hour already processed
automatically. Codes appear in Today’s Codes and are tracked individually.
Repeated requests for the same manual run ID protect against duplicate sends.
See [TELEGRAM_MANUAL_ALL_PICKS.md](TELEGRAM_MANUAL_ALL_PICKS.md).

The daily API endpoint alone still requests only SAFE. For an immediate manual
QC/live API request:

```bash
curl --fail-with-body --silent --show-error --max-time 780 \
  -X POST 'https://matchday-odds-desk.onrender.com/api/telegram/quick-cash' \
  -H 'Content-Type: application/json' \
  -H 'x-telegram-job-secret: YOUR_TELEGRAM_JOB_SECRET' \
  -H 'x-matchday-run-mode: manual' \
  -H 'x-matchday-run-id: YOUR_UNIQUE_RUN_ID' \
  --data '{}'
```

Reuse the run ID to retry that intentional run; use a new one for a new batch.
A category with no eligible games cannot create a booking code. Source errors
and skipped categories are visible in the response and shared status.

## Website and interactive Telegram bot

The website's **Send to Telegram** button uses the existing bot and chat settings
and a short-lived one-time send token. The browser does not receive your bot
token or job secret. This button is separate from the hourly timer.

For the interactive Telegram analyser, plans and builder, retain the existing
second-bot/webhook settings described in
[TELEGRAM_AI_BOT_SETUP.md](TELEGRAM_AI_BOT_SETUP.md). Live selection rules apply
there as well; user-selected probability settings remain active.
