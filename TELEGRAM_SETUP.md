# Telegram booking-code setup

Telegram analysis and results read public SportyBet data. Creating a new code uses anonymous SportyBet sharing by default, without dummy credentials or session recovery. The new hourly batch sends Live 3 odds at 85%, QC 3 odds at **80%**, and Live 1,000 odds at 85%; see [TELEGRAM_HOURLY_MODEL_PICKS.md](TELEGRAM_HOURLY_MODEL_PICKS.md) for the latest archive and installation.

All pick workflows scan the current public SportyBet board without waiting for
the daily catalogue cache. The next-12-hours builder runs even when the cache is
empty and another refresh holds its lease. See
[TELEGRAM_PUBLIC_PICKS_FIX.md](TELEGRAM_PUBLIC_PICKS_FIX.md) for the latest update.

The auto-pick request handler queues one recoverable job and polls its status instead
of keeping a long HTTP connection open. Empty SAFE slates are normal outcomes;
source, booking and delivery failures show their actual details in the workflow.
See [TELEGRAM_AUTO_PICK_FIX.md](TELEGRAM_AUTO_PICK_FIX.md) for deployment and checks.

| Ticket/update | Time in WAT | Scheduler |
| --- | --- | --- |
| Live 3 odds (85%), QC 3 odds (80%), Live 1,000 odds (85%) | :05 every hour | App server |
| Next 12h: 10,000, 2,500, 500, three 100 variations | 07:00 and 18:00 daily | App server |
| SAFE; 85%, combined odds 1.30–5.00 | 08:25 daily | GitHub Actions |
| Results, closest/worst tickets and hypothetical ₦100 ROI | 00:10 and 12:10 | GitHub Actions |

See [SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md](SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md) for the current changes and installation, and [PUBLIC_CACHE_AND_NEXT12H_PICKS.md](PUBLIC_CACHE_AND_NEXT12H_PICKS.md) for the next-12-hours selection and delivery rules.

## Bot, destination and server settings

Retain your existing bot/chat and persistent Redis settings. If setting up a new bot, use Telegram's @BotFather, start a conversation with your bot and obtain the chat ID through its `getUpdates` response. For a channel, grant your bot permission to post and use its channel ID or supported channel username.

Keep these values privately on the application host:

```text
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your chat/channel ID>
REDIS_URL=<your persistent Redis connection>
TELEGRAM_JOB_SECRET=<your existing job secret>
```

Keep the same job secret in GitHub Actions for retained scheduled jobs and manual triggers. `MATCHDAY_BASE_URL` can be a repository variable; the existing Render URL is the fallback. Booking defaults to `SPORTYBET_BOOKING_MODE=public`; see [SPORTYBET_ANONYMOUS_BOOKING.md](SPORTYBET_ANONYMOUS_BOOKING.md). No dummy credentials are needed.

The app reports missing `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` or `REDIS_URL`
before an asynchronous pick job scans SportyBet. These settings belong on Render.

## Deployment and manual picks

Commit/push the updated archive and deploy. `npm start` starts the website, hourly model picks, three public refresh slots and twice-daily next-12-hours scheduler. Check `GET /api/telegram/status` for the hourly scheduler, SAFE, next-12-hours targets and the 12-hour result report. The service must stay running for its application schedules; Redis retains delivery locks, code history and tracked results across restarts.

**Matchday Telegram Auto Picks → Run workflow** sends SAFE. **Plot207 Telegram Next 12 Hours Picks → Run workflow** sends the six next-12-hours targets. **Plot207 Telegram Hourly Live and QC Picks → Run workflow** requests the new three hourly tickets immediately. The separate results workflow remains available. The retired five-category workflow stays removed, and its old `/api/telegram/quick-cash` route returns HTTP 410 without booking or posting.

Previously sent ticket records remain available for Today's Codes and result reports.
The new workflows use `Prefer: respond-async` and `GITHUB_RUN_ID`; repeated
requests retrieve the same job rather than posting another batch. A new manual
workflow dispatch still requests a new batch at any time. Deploy the updated
server before running the updated workflows.
Use **Run workflow** to start a new run after this deployment. **Re-run jobs**
on an old failed run retrieves its saved result under the same GitHub run ID.

## Website and interactive bot

The website's Send to Telegram button and live/Quick Cash analyser remain available. The send button uses the existing one-time send token. Interactive Telegram builder/analyser settings are documented in [TELEGRAM_AI_BOT_SETUP.md](TELEGRAM_AI_BOT_SETUP.md); user-selected probabilities and live selection checks remain active.
