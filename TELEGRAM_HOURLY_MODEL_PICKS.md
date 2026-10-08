# Hourly Live and Quick Cash Telegram picks

The app now scans SportyBet's current public live board every hour and requests
three additional tickets using the existing probability models:

| Ticket | Combined odds target | Minimum probability per selection |
| --- | --- | --- |
| Live | 3.00 | 85% |
| Quick Cash (QC) | 3.00 | **80%** |
| Live | 1,000.00 | 85% |

These are accumulator odds targets, not game counts. Football, Basketball, Ice
Hockey, Handball, Volleyball and Tennis are considered, including every supported
offered bet type and corner markets where current corner scores are available.

The existing SAFE morning pick, six twice-daily next-12-hours tickets, public
catalogue refreshes and results/ROI reports remain active. The previously removed
five-category hourly batch and its `/api/telegram/quick-cash` endpoint remain
retired; this new three-ticket batch has a separate scheduler switch and route.

## Selection and booking

Each scan uses the public live fixture and event-market feeds, independently of
the daily catalogue cache and dummy login. It uses the existing SportyBet
statistics model where available, otherwise complete no-vig market estimates.
Football live estimates incorporate the current score and remaining time when
the goal model is available.

Live selections must be ongoing, at least halfway through the match and already
winning against the selected offered bet type. QC also requires a late stage:
football from 75 minutes, basketball in the fourth quarter or overtime, hockey
in the third period or overtime, handball from 50 minutes in the second half,
and tennis/volleyball in the deciding set of the known match format. Unknown
scores, ended games, unsupported market evaluations and losing selections are
excluded. Set sports use completed sets rather than elapsed minutes.

The bounded combination search ranks the estimated winning chance of the whole
ticket, using one selection per fixture and at most 40 selections. It may exceed
the requested target slightly. "Safest" means the strongest estimated combination
found under these rules, not a guarantee or an exact global optimum. A 1,000-odds
ticket can have a small combined winning chance despite strong individual picks;
Telegram displays the combined estimate and its independence assumption.

Before each booking, another public live scan rebuilds the probabilities and
selection combination. The QC 80% minimum is checked again at this point. It
cannot be lowered by a leftover zero-probability configuration. Suspended,
removed, losing or below-minimum selections are excluded. If enough qualifying
games cannot reach a target, no lower-odds code is substituted; an hourly check
message explains which targets were unavailable.

Booking uses anonymous SportyBet sharing by default. This feature generates
reservation codes and sends the selected games to Telegram; it does not place
a funded wager. Generated codes appear in Today's Codes and enter the existing
tracked results and hypothetical ₦100-per-ticket ROI reports.

## Automatic delivery and retries

The application's timer runs at **:05 every hour in WAT (Africa/Lagos)**. It
does not depend on GitHub cron. A restarted app catches up its current hour
after :05, with Redis preventing a completed hour or ticket from being sent
again. The service must stay running for automatic schedules.

Confirmed source or booking failures retry after two minutes within the current
hour. Tickets already sent are preserved, and a known prepared booking code is
reused. Lost responses that make booking or Telegram delivery uncertain are
reserved and are not automatically submitted again. A completed hourly notice
is not a played ticket and is not counted in the ROI calculation.

Keep the existing Render settings:

```text
REDIS_URL=<your existing persistent Redis connection>
TELEGRAM_BOT_TOKEN=<your existing bot token>
TELEGRAM_CHAT_ID=<your existing destination>
SPORTYBET_BOOKING_MODE=public
```

The new batch defaults to enabled. Optional settings:

```text
TELEGRAM_HOURLY_MODEL_ENABLED=true
TELEGRAM_HOURLY_MINUTE=5
TELEGRAM_HOURLY_LIVE_MIN_PROBABILITY=85
TELEGRAM_HOURLY_QC_MIN_PROBABILITY=80
TELEGRAM_HOURLY_MAX_SELECTIONS=40
```

`TELEGRAM_HOURLY_QC_MIN_PROBABILITY` may raise the QC minimum but cannot lower
it below 80%. An old `TELEGRAM_HOURLY_ENABLED=false` for the retired batch does
not disable the new batch. Set `TELEGRAM_HOURLY_MODEL_ENABLED=false` to stop its
automatic timer. Manual requests remain available.

## Install on your Mac

Download `matchday-odds-desk-hourly-live-qc-picks.zip` into Downloads, then run:

```bash
cd ~/Documents &&
update_dir=$(mktemp -d /tmp/matchday.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-hourly-live-qc-picks.zip -d "$update_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$update_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Add hourly Live 3, QC 3 at 80%, and Live 1000 Telegram picks" &&
git push origin main
```

Wait for Render to finish deploying. Keep build command
`npm ci --ignore-scripts=false` and start command `npm start`.

`GET /api/telegram/status` should show `hourlyScheduler.running: true`,
`source: app-server`, minute 5 and the three plans with probability minimums
85, 80 and 85. It also reports missing bot/chat/Redis settings.

To request all three tickets immediately, start a new manual run of
**Actions → Plot207 Telegram Hourly Live and QC Picks → Run workflow**. It uses
the existing `TELEGRAM_JOB_SECRET` and the protected `/api/telegram/hourly-picks`
route. The Python runner queues one recoverable job and polls its status. A
repeated run ID retrieves that run instead of booking or posting again. Start
a new workflow run to request a fresh batch at any time.

## Verification

All **404 tests passed**, with no failures or skipped tests. JavaScript, inline
website JavaScript, the Python runner and all 13 workflow files also passed
syntax checks.

The tests exercise the real app HTTP routes and Python workflow runner with
controlled SportyBet, Redis and Telegram responses. They cover the three
targets, all six sports, QC's exact 80% boundary, final probability checks,
hourly timing, empty boards, source failures, partial retries, preserved codes,
lost ownership, cancellation and duplicate prevention. Existing daily,
next-12-hours, public-cache and booking tests are also retained.

The download has not deployed Render or sent a real Telegram message. Automatic
delivery starts after installing and deploying this update on the running app.
