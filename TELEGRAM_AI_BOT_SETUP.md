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

## Interactive Auto Builder UI

The Telegram AI bot now mirrors the core website Auto Builder through inline buttons. Users can configure:

- Sport scope: Football, Basketball, Ice Hockey, or All Sports (subject to plan)
- Target combined odds
- Minimum probability
- Maximum odds per match
- Minimum football edge
- Maximum selections/games
- Exact allowed bet types
- SAFE mode (1.30–1.35 target with 80%+ legs)
- Red-flag protection is always applied server-side

The Analyzer also has button controls for the minimum KEEP probability and 7/14/21-day fixture search horizon.

The webhook path did not change, so if `/api/telegram/bot/webhook` is already registered for the AI bot, you do not need to register it again after deploying this update.


## Bet-type access by subscription

The Telegram Auto Builder enforces bet-type access server-side:

- **Free — ₦0:** Football only; **Home, Draw, Away** only.
- **Pro — ₦5,000/month:** 5 tickets/day, 2 analyses/day, Football + Basketball only. Hockey is locked.
- **Elite — ₦20,000/month:** 10 tickets/day, 5 analyses/day, all supported sports and all supported bet types.

Locked markets are displayed with a 🔒 button. The restriction is also re-checked when a ticket is built, so a user cannot bypass the plan by sending a crafted Telegram callback or natural-language request.


## Manual bank-payment request flow

When a customer taps **Choose Pro** or **Choose Elite**, the AI bot now sends every Telegram administrator in `TELEGRAM_ADMIN_IDS` a payment request containing:

- selected plan and amount
- customer's first name / username
- customer's numeric Telegram ID
- a **Open Customer Chat** button
- an **Activate PRO/ELITE 30 Days** admin-only button

The customer is told that the administrator will contact them in Telegram with payment/account details. Bank account details are not stored in the bot.

After independently confirming payment, an administrator can tap the activation button or use `/activate USER_ID pro 30` / `/activate USER_ID elite 30`.

Security: the activation callback verifies that the person pressing it is listed in `TELEGRAM_ADMIN_IDS`.


## Minimum probability
Minimum probability is not subscription-capped. Free, Pro and Elite users can choose minimum probability from 0% through 95%; there is no subscription minimum-probability floor. Plain-language ticket requests may also specify a minimum probability directly (for example, `minimum probability 73%`).


## Conversational LLM

The customer bot now supports a real conversational LLM through the OpenAI Responses API. The LLM is used as the conversation/intent layer only. Matchday's existing engine remains authoritative for fixtures, SportyBet odds, probabilities, red flags, booking codes, plan limits and usage limits.

Add these Render environment variables:

- `OPENAI_API_KEY` — required to enable conversational LLM mode.
- `OPENAI_MODEL` — optional. Default: `gpt-5.6-luna`.

Examples:
- "I want something safe today around 10 odds, football only."
- "Nothing above 1.30 per game and don't use draws."
- "What can I do on my current plan?"
- "Analyze RKT1JT."

The bot retains a short per-user conversation history in the existing user record so follow-up messages can use recent context. If the OpenAI request fails or no API key is configured, existing structured commands and Telegram buttons continue to work.

Security/design: the LLM cannot activate plans or bypass plan market/sport limits. It is instructed not to invent matches, odds, probabilities, results or booking codes.


## Daily conversational AI limits

To protect API credit from misuse, conversational LLM calls are limited per Telegram user and reset daily:

- Free: 10 AI chat messages/day
- Pro: 30 AI chat messages/day
- Elite: 75 AI chat messages/day

Ticket and analyzer limits remain separate. The account screen shows AI chat usage. Telegram buttons and existing supported direct commands do not consume the LLM quota when they can be handled locally.
