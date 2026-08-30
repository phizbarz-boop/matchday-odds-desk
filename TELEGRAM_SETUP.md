# Telegram Auto Picks Setup

This build can automatically create SportyBet booking codes for target combined odds and send them to a Telegram chat twice per day.

Default target odds:

- 1000
- 750
- 250
- 100
- 50
- 20

The scheduled job scans the selected sport scope once, builds one probability-weighted slip for each target, books each slip through the existing Parse.bot SportyBet API, and sends the code + selections to Telegram.

## 1. Create a Telegram bot

1. Open Telegram and search for **@BotFather**.
2. Send `/newbot`.
3. Follow the prompts to choose a bot name and username.
4. BotFather returns a token similar to `123456789:AA...`.
5. Keep this token private.

## 2. Find your Telegram chat ID

1. Open the bot you just created and send it `/start` or any message.
2. In a browser, use Telegram's Bot API `getUpdates` endpoint with your bot token:
   `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Find `message.chat.id` in the returned JSON. That number is your private chat ID.

For a Telegram channel, add the bot to the channel and use the channel's numeric chat ID or supported `@channelusername` as `TELEGRAM_CHAT_ID`.

## 3. Add these Render Environment Variables

Open:

Render Dashboard -> matchday-odds-desk -> Environment

Add:

```text
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_CHAT_ID=<your chat id>
TELEGRAM_JOB_SECRET=<a long random secret you create>
TELEGRAM_TARGET_ODDS=1000,750,250,100,50,20
TELEGRAM_SPORT_SCOPE=all
TELEGRAM_MIN_PROBABILITY=55
TELEGRAM_MAX_SELECTIONS=30
TELEGRAM_PICK_TRIALS=2200
```

Optional football league restriction:

```text
TELEGRAM_FOOTBALL_LEAGUES=Premier League,La Liga,Serie A,Bundesliga,Ligue 1,Champions League
```

If omitted, the Telegram job uses every football league available to your predictions data.

Allowed `TELEGRAM_SPORT_SCOPE` values:

```text
all
football
basketball
hockey
```

## 4. Add the GitHub secret

Your repository includes:

```text
.github/workflows/telegram-picks.yml
```

In GitHub open:

Repository -> Settings -> Secrets and variables -> Actions -> New repository secret

Create:

```text
Name: TELEGRAM_JOB_SECRET
Value: <EXACT SAME VALUE as TELEGRAM_JOB_SECRET in Render>
```

Do not put your Telegram bot token in GitHub. The workflow only needs the job secret; Render holds the Telegram token and chat ID.

## 5. Default twice-daily schedule

The included workflow runs at:

```text
09:15 America/New_York
18:15 America/New_York
```

To change the schedule edit:

```text
.github/workflows/telegram-picks.yml
```

and change the `cron` / `timezone` values.

## 6. Test Telegram before waiting for the schedule

After Render deploys, test from your Mac Terminal:

```bash
curl -X POST "https://matchday-odds-desk.onrender.com/api/telegram/test" \
  -H "Content-Type: application/json" \
  -H "x-telegram-job-secret: YOUR_TELEGRAM_JOB_SECRET" \
  --data '{}'
```

Your Telegram chat should receive:

```text
✅ Matchday Odds Desk Telegram integration is connected.
```

## 7. Test the complete six-code job manually

```bash
curl -X POST "https://matchday-odds-desk.onrender.com/api/telegram/daily-picks" \
  -H "Content-Type: application/json" \
  -H "x-telegram-job-secret: YOUR_TELEGRAM_JOB_SECRET" \
  --data '{}'
```

This consumes SportyBet/Parse booking credits because it actually creates each code.

You can also run it from GitHub:

GitHub -> Actions -> Matchday Telegram Auto Picks -> Run workflow

## Credit usage

With six target codes and two runs per day, the Telegram job creates up to 12 booking codes per day. If your Parse plan charges 2 credits per successful `book_bet`, that is about 24 booking credits/day or about 720 booking credits in a 30-day month, excluding market data calls.

To reduce usage, change for example:

```text
TELEGRAM_TARGET_ODDS=100,50,20
```

No source-code change is required.

## Website: Send generated code to Telegram

After a SportyBet code is generated on the website, the code box now includes a **Send to Telegram** button. The browser never receives your Telegram bot token or Telegram job secret. The server creates a short-lived one-time token (10 minutes), and pressing the button sends the exact current slip, combined odds, probabilities, booking code, and SportyBet link to the configured Telegram channel.

No additional Render environment variable is required for this button. It uses the existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

## Probability + value engine (v2)

The Auto Builder now calculates, for each eligible selection:

- **Bookmaker implied probability** = `100 / decimal odds`
- **Probability edge** = selection probability minus bookmaker implied probability
- **Estimated EV %** = `(probability × decimal odds - 1) × 100`
- **Market reliability weight** based on the supported market type
- **Quality score (0–100)** combining probability, edge and market reliability
- **Estimated full-slip probability** by multiplying the leg probabilities (assumes independence)

Football uses the independent Poisson + capped-H2H model, so its edge is a true **model-vs-price estimate**. Basketball and ice hockey currently use de-margined SportyBet market probabilities, so their displayed edge is a **market-adjusted pricing metric**, not an independent predictive edge.

Optional Telegram environment setting:

```text
TELEGRAM_MIN_EDGE=0
```

This filters Football candidates whose Poisson+H2H probability edge is below the chosen number of percentage points. Example: `TELEGRAM_MIN_EDGE=3` requires at least a +3 point football model-vs-price edge. Basketball and hockey are not hard-filtered by this setting until independent statistical models are added for those sports.
