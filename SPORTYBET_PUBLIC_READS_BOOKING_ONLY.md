# Public SportyBet reads and anonymous booking

Current update: booking also uses the public website's anonymous sharing operation. See [SPORTYBET_ANONYMOUS_BOOKING.md](SPORTYBET_ANONYMOUS_BOOKING.md). The website retains recoverable requests instead of aborting the operation after 18 seconds.

Telegram workflows now use recoverable jobs too; see
[TELEGRAM_HOURLY_MODEL_PICKS.md](TELEGRAM_HOURLY_MODEL_PICKS.md) for the latest archive and installation. All pick workflows scan the current public board without requiring the catalogue cache.

User requests read SportyBet's public website JSON feeds. Fixtures, odds, full event markets, live/QC analysis, imported booking-code analysis, replacement selections, result checks and public cache refreshes do not load or send dummy-account credentials. The optional football statistics collector opens public match pages in a fresh browser context.

There is no startup login or background session keep-alive in the website. An expired dummy session or failed sign-in cooldown cannot prevent public analysis. A public-feed error is reported as a source error; it does not trigger an account login or substitute old market prices.

Creating a booking code uses anonymous `POST /orders/share` by default. The server rechecks live selections publicly and sends only the event, market, specifier and outcome IDs. It does not load the saved dummy session or fall back to login after a rejected public request. The older account adapter remains available only with the explicit `SPORTYBET_BOOKING_MODE=session` setting.

## Telegram schedules

The former five-category hourly QC and Live All Sports batch remains retired. Legacy calls to `POST /api/telegram/quick-cash` return HTTP 410 without booking or sending. The new three-ticket hourly model batch uses its own `/api/telegram/hourly-picks` route and `TELEGRAM_HOURLY_MODEL_ENABLED` switch.

The following remain active:

| Pick or update | Schedule in WAT | Source/authentication |
| --- | --- | --- |
| Safest Live 3, QC 3, flexible Live up to 1,000; no probability floor | :05 every hour, app server | Current public live board and anonymous booking |
| Morning SAFE | 08:25 daily, GitHub Actions | Public markets and anonymous booking |
| Next 12 hours: 10,000, 2,500, 500, three 100 targets | 07:00 and 18:00 daily, app server | Current public board, fresh market checks and anonymous booking |
| Results and hypothetical ₦100-per-ticket ROI | 00:10 and 12:10, GitHub Actions | Public booking-code lookup and event results |
| Public fixture/market cache | 06:30, 12:30 and 17:30 daily, app server | Public, no dummy account |

The website and interactive Telegram builder/analyser retain live and Quick Cash modes. Previously sent ticket records remain available for result/ROI reports and Today's Codes. The daily manual GitHub workflow sends SAFE; the next-12-hours workflow retains its separate manual trigger.

## Install on your Mac

Download this ZIP to Downloads, then run:

```bash
cd ~/Documents &&
update_dir=$(mktemp -d /tmp/plot207-update.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-anonymous-booking.zip -d "$update_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$update_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Generate SportyBet booking codes without dummy login" &&
git push origin main
```

Keep the Render build command `npm ci --ignore-scripts=false` and start command `npm start`. Set `SPORTYBET_BOOKING_MODE=public` or leave it unset. Keep the existing Redis and Telegram settings. Dummy credentials and browser installation are not required for public booking.

## Validation

All 343 Node tests passed. Tests verify anonymous reads and booking despite configured or expired dummy credentials, no account headers or private-session changes, public failures without login fallback, exact selection payloads, code lookup, asynchronous recovery after a lost HTTP connection, removed hourly endpoints, retained Telegram picks and public results/ROI. Explicit legacy session mode is also covered with fake credentials and local Chromium fixtures. A real logged-out SportyBet browser and a separate server request both generated code `RF33A7`; the updated booking and lookup functions returned the same code without loading a session. No real account login, wager or Telegram send was performed. Render deployment remains a separate step.
