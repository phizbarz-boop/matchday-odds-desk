# Public SportyBet reads and booking-only login

Current booking-timeout update: the website tracks a recoverable booking request instead of aborting the whole operation after 18 seconds. See [SPORTYBET_BOOKING_TIMEOUT_FIX.md](SPORTYBET_BOOKING_TIMEOUT_FIX.md).

User requests read SportyBet's public website JSON feeds. Fixtures, odds, full event markets, live/QC analysis, imported booking-code analysis, replacement selections, result checks and public cache refreshes do not load or send dummy-account credentials. The optional football statistics collector opens public match pages in a fresh browser context.

There is no startup login or background session keep-alive in the website. An expired dummy session or failed sign-in cooldown cannot prevent public analysis. A public-feed error is reported as a source error; it does not trigger an account login or substitute old market prices.

Creating a booking code remains authenticated. The server rechecks live selections publicly before booking, then loads and verifies the saved dummy session. It refreshes or signs in automatically when needed. Concurrent bookings share recovery, and safe failure diagnostics are returned only by the booking request. Redis session persistence, browser installation and the previous page-check fix remain available.

## Telegram schedules

The hourly QC and Live All Sports Telegram picks are removed, including startup catch-up, hourly retries, manual hourly batches and the hourly GitHub workflow. Legacy calls to `POST /api/telegram/quick-cash` return HTTP 410 without booking or sending. Old `TELEGRAM_HOURLY_*` settings cannot enable that retired endpoint.

The following remain active:

| Pick or update | Schedule in WAT | Source/authentication |
| --- | --- | --- |
| Morning SAFE | 08:25 daily, GitHub Actions | Public markets; dummy account for booking |
| Next 12 hours: 10,000, 2,500, 500, three 100 targets | 07:00 and 18:00 daily, app server | Public cache and fresh market checks; dummy account for booking |
| Results and hypothetical ₦100-per-ticket ROI | 00:10 and 12:10, GitHub Actions | Public booking-code lookup and event results |
| Public fixture/market cache | 06:30, 12:30 and 17:30 daily, app server | Public, no dummy account |

The website and interactive Telegram builder/analyser retain live and Quick Cash modes. Previously sent ticket records remain available for result/ROI reports and Today's Codes. The daily manual GitHub workflow sends SAFE; the next-12-hours workflow retains its separate manual trigger.

## Install on your Mac

Download this ZIP to Downloads, then run:

```bash
cd ~/Documents &&
update_dir=$(mktemp -d /tmp/plot207-update.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-booking-timeout-fix.zip -d "$update_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$update_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Use public SportyBet reads; reserve dummy login for booking; remove hourly Telegram picks" &&
git push origin main
```

Keep the existing Render build command `npm ci --ignore-scripts=false` and start command `npm start`. Keep the dummy credentials and Telegram settings privately on the service; dummy credentials are needed when a code is created.

## Validation

All 332 Node tests passed. Tests verify public reads with configured and saved dummy credentials, missing/expired sessions, no account headers, unchanged private session storage, public feed errors without login fallback, booking-time recovery and its shared cooldown, safe failure diagnostics, removed hourly endpoints and schedules, retained next-12-hours picks, public results/ROI and website live/QC booking. Real Chromium tests use local fixtures and fake credentials. No real account login, booking or Telegram send was performed for this update.
