# Telegram booking-code setup

Telegram analysis and results read public SportyBet data. Creating a new code uses anonymous SportyBet sharing by default, without dummy credentials or session recovery. The hourly QC/live Telegram batch has been removed; legacy hourly settings cannot start it again.

| Ticket/update | Time in WAT | Scheduler |
| --- | --- | --- |
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

## Deployment and manual picks

Commit/push the updated archive and deploy. `npm start` starts the website, three public refresh slots and twice-daily next-12-hours scheduler. Check `GET /api/telegram/status` for SAFE, next-12-hours targets and the 12-hour result report. The service must stay running for its application schedules; Redis retains delivery locks, code history and tracked results across restarts.

**Matchday Telegram Auto Picks → Run workflow** sends SAFE. **Plot207 Telegram Next 12 Hours Picks → Run workflow** sends the six next-12-hours targets. The separate results workflow remains available. The hourly QC/live workflow has been removed, and the old `/api/telegram/quick-cash` route returns HTTP 410 without booking or posting.

Previously sent ticket records remain available for Today's Codes and result reports.

## Website and interactive bot

The website's Send to Telegram button and live/Quick Cash analyser remain available. The send button uses the existing one-time send token. Interactive Telegram builder/analyser settings are documented in [TELEGRAM_AI_BOT_SETUP.md](TELEGRAM_AI_BOT_SETUP.md); user-selected probabilities and live selection checks remain active.
