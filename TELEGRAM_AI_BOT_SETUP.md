# Matchday AI Telegram Bot

This build adds a conversational Telegram bot on top of the existing Matchday Odds Desk engine. It does not replace the website or the twice-daily Telegram channel jobs.

## Plans and limits

| Plan | Price | Tickets/day | Max target | Max selections | Sports | Analyzer/day | Copy Hub |
|---|---:|---:|---:|---:|---|---:|---|
| Free | ₦0 | 2 | 10x | 12 | Football | 0 | No |
| Pro | ₦5,000/month | 10 | 100x | 30 | Football, Basketball, Ice Hockey | 5 | No |
| Elite | ₦20,000/month | 40 | 1000x | 40 | All currently supported sports | 30 | Yes |

The limits are enforced server-side per Telegram user. A Redis service is strongly recommended so subscriptions and usage survive Render restarts.

## Required Render environment variables

Keep the existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_JOB_SECRET`. `TELEGRAM_BOT_TOKEN` remains dedicated to your existing scheduled/channel bot.

Add:

- `TELEGRAM_AI_BOT_TOKEN` = token from BotFather for the NEW customer-facing Matchday AI bot. Do not reuse `TELEGRAM_BOT_TOKEN`.
- `TELEGRAM_WEBHOOK_SECRET` = a long random value. Telegram sends it back in the webhook secret header.
- `MATCHDAY_BASE_URL` = your public Render URL, e.g. `https://your-service.onrender.com`
- `TELEGRAM_ADMIN_IDS` = your Telegram numeric user ID. Multiple admins can be comma-separated.
- `TELEGRAM_AI_ENABLED=true`
- `REDIS_URL` = recommended for persistent users/subscriptions/usage.

Optional checkout/support buttons:

- `PRO_PAYMENT_URL` = your hosted checkout/payment link for ₦5,000 Pro.
- `ELITE_PAYMENT_URL` = your hosted checkout/payment link for ₦20,000 Elite.
- `TELEGRAM_SUPPORT_URL` = e.g. a Telegram `https://t.me/...` support URL.

## Activate the webhook once after deployment

Send a POST request to:

`/api/telegram/bot/setup`

with request header:

`x-telegram-job-secret: <TELEGRAM_JOB_SECRET>`

The endpoint registers the webhook and the `/start`, `/plans`, `/account`, `/help` commands.

## Admin subscription activation

From the Telegram account whose numeric ID is in `TELEGRAM_ADMIN_IDS`:

`/activate TELEGRAM_USER_ID pro 30`

or

`/activate TELEGRAM_USER_ID elite 30`

The user is notified automatically after activation.

## Natural-language examples

- `10x`
- `Build a football 20x ticket`
- `Build 50 odds, max odds 1.25`
- `Football 20x minimum probability 75%`
- `Safe ticket`
- `Only over 0.5, 10x`
- `Analyze RKT1JT`
- `My account`
- `Plans`
- `Copy rankings` (Elite)

Every ticket is built through the existing Matchday candidate engine, red-flag protection, stale-fixture protection, and SportyBet booking-code generator.
