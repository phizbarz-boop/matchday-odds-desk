# SportySocial Automatic Collector (Twice Daily)

This version adds a fully automated SportySocial collector for the Copy Hub.

## Architecture

GitHub Actions (Playwright) logs into the dedicated/dummy SportyBet account, opens the normal mobile Code Hub page, observes the Code Hub's own `socialpage/my/suggested` JSON responses, strips account/session data, and sends only public punter + booking-code records to Matchday.

**Render never receives the SportyBet password, cookie, OTP, or browser session.**

The collector does not place bets, access deposits/withdrawals, or bypass CAPTCHA/OTP/security checks.

## GitHub Secrets (required once)

Repository -> Settings -> Secrets and variables -> Actions -> Secrets -> New repository secret

Create these three secrets:

- `SPORTYSOCIAL_LOGIN_ID` = the mobile number/login identifier exactly as you enter it on SportyBet.
- `SPORTYSOCIAL_PASSWORD` = password of the dedicated/dummy collector account.
- `COPY_HUB_SECRET` = the same Copy Hub secret already stored in Render.

Do not put these values in source code.

## GitHub Variables (optional)

Repository -> Settings -> Secrets and variables -> Actions -> Variables

- `MATCHDAY_BASE_URL` = `https://matchday-odds-desk.onrender.com`
- `SPORTYSOCIAL_MAX_PAGES` = `5`

If `MATCHDAY_BASE_URL` is not set, the script already defaults to the Matchday Render URL above. If max pages is omitted, it defaults to 5.

## Schedule

`.github/workflows/sportysocial-copy-hub.yml` runs at:

- 06:00 UTC = 07:00 Nigeria (WAT)
- 18:00 UTC = 19:00 Nigeria (WAT)

It can also be run manually from GitHub Actions with **Run workflow** for the first test.

## New Render endpoint

`POST /api/copy/sportysocial/import-batch`

Protected by `x-copy-hub-secret`. It accepts only sanitized SportySocial Code Hub records and imports them into the same global booking-code ownership system used by X.

## Ownership behavior

SportySocial `userId` is the stable punter identity. `createTime` is treated as the verified SportyBet publication timestamp. If the same booking code later appears on X, Telegram, or another SportySocial account, the earliest verified publication becomes ORIGINAL and later publications are REPOSTS.

## Important

If SportyBet changes its login UI, or starts requiring CAPTCHA/OTP for the collector login, the workflow will fail safely and will not attempt to bypass verification. Existing Matchday features continue running normally.
