# Optional legacy SportyBet account recovery

The default `SPORTYBET_BOOKING_MODE=public` generates booking codes anonymously and skips account recovery and Chromium installation. This document applies only when you explicitly choose `SPORTYBET_BOOKING_MODE=session`. Use [SPORTYBET_ANONYMOUS_BOOKING.md](SPORTYBET_ANONYMOUS_BOOKING.md) for the current default setup.

The server renews accepted sessions and signs back in through SportyBet's own
Nigeria login form when refresh is rejected. Normal expiry no longer requires
copying browser cookies into Render. This recovery is used only when creating
booking codes. Analysis and result reads use public SportyBet data.

## One-time Render setup

1. Install this archive into the existing repository, commit/push and deploy.
   Keep the existing Telegram and persistent Redis settings.
2. In the Render service environment, set these values privately:

   ```text
   SPORTYBET_BOOKING_MODE=session
   SPORTYBET_PHONE=<dummy-account mobile number>
   SPORTYBET_PASSWORD=<dummy-account password>
   SPORTYBET_LOGIN_METHOD=browser
   ```

   Browser login is the default within session mode. The Nigeria form supplies +234 separately;
   the adapter accepts a number beginning with 234, a local leading 0, or the
   ten-digit local number. Do not put credentials into source files or chat.
   `SPORTYBET_BOOTSTRAP_COOKIES` is optional; existing unchanged bootstrap
   settings cannot overwrite a newer saved session after a restart.
3. Use Node 20 or newer. Set the **Build Command** to:

   ```bash
   npm ci --ignore-scripts=false
   ```

   Keep the **Start Command** as `npm start`. `npm install` also works. Both run the
   project's postinstall step to download the pinned Chromium browser when
   `SPORTYBET_BOOKING_MODE=session` is configured during the build. Build
   and runtime default to `PLAYWRIGHT_BROWSERS_PATH=0`, placing the browser
   inside the deployed package; an explicit prepared-browser path is retained.
   A failed browser installation fails the build. No browser download or manual
   cookie capture is required during an ordinary renewal.
4. Save/redeploy. Check `/api/sportybet/diagnostics`, then create a booking code
   to exercise account recovery on your deployment. Auto Analyser remains public
   and does not exercise account recovery.

If the native Render runtime is missing Chromium system libraries, use the
included `Dockerfile` and `.dockerignore`: it installs the pinned Playwright
browser and Linux dependencies during the image build and runs the server as
the `node` user. Change the existing service runtime to Docker following
[Render's runtime instructions](https://render.com/docs/native-runtimes),
use `./Dockerfile`, and let its `CMD` start the app. Remove the native
`PLAYWRIGHT_BROWSERS_PATH=0` setting for Docker: the image sets `/ms-playwright`.
Keep the same dummy-account, Redis and Telegram environment values. The Docker
image has not been built on your Render deployment here.

Keep persistent Redis enabled so renewed credentials, ticket history and duplicate-protection records survive deployments. Scheduled public refreshes and next-12-hours Telegram picks require the application to stay running. Hourly QC/live Telegram picks have been removed.

## What runs automatically

- When a code is being created, load the saved session from Redis or the private local file and check the account. Public reads and startup never initiate this recovery.
- At booking, refresh an expired/rejected or aging session before browser sign-in. Rotated access and refresh tokens are saved automatically, including credentials returned in the response body rather than Set-Cookie headers.
- If the configured refresh route returns 404 or 405, retain a still-accepted
  session and stop calling that route until the process restarts. An expired
  or rejected session then recovers through the configured browser sign-in.
- After an expired/revoked session cannot refresh, launch one browser, open
  SportyBet's own login form, enter the configured dummy credentials once and
  verify the account before exporting its session cookies.
- Share recovery across simultaneous bookings. Retry a rejected
  authenticated request once with the recovered session.
- Persist the recovered session. Ordinary restarts reuse it without cookie
  copying or another password submission.

The browser adapter does not place a wager. In explicit session mode, website and retained Telegram booking-code generation use the same recovery. Public reads continue without it. Public booking mode never invokes this recovery, even after a rejected sharing request.

## Diagnostics and exceptions

The diagnostics session object shows:

```text
automaticLoginMethod: "browser"
bookingMode: "session"
bookingLoginRequired: true
automaticReloginConfigured: true
lastLoginMethod: "browser"
lastAuthenticatedAt: <recent successful account verification>
lastRefreshAt: <recent accepted refresh or login>
backgroundLoginEnabled: false
authenticationScope: "booking"
dataReadAccess: "public"
requiresUserAction: false
```

`lastLoginMethod` can remain empty until browser sign-in is actually needed;
an existing accepted session does not need to log in again. `loggedIn` alone
is a local credential check, so also assess the recent verification timestamp
and successful data probe. Diagnostics never include credential values.
`refreshEndpointUnavailable: true` records a missing or unsupported refresh
route. Browser recovery remains configured independently of that route.

`lastLoginFailure` gives the fixed stage and reason for a failed automatic
sign-in, with a known network code or bounded status codes when available.
`nextLoginRetryAt` shows its cooldown. The public-data probe is anonymous and
does not establish that account authentication succeeded. See
[SPORTYBET_PAGE_CHECK_FIX.md](SPORTYBET_PAGE_CHECK_FIX.md) for the latest
page-check timeout fix and the meaning of the next logs. The earlier sign-in,
proxy and public-cache lease changes are in
[SPORTYBET_BROWSER_SIGNIN_FIX.md](SPORTYBET_BROWSER_SIGNIN_FIX.md).

SportyBet can request an OTP/CAPTCHA, reject a password/account, block access
from the server or change its form. Recovery stops at a verification prompt
and reports the reason. Verification and rejected credentials have a
15-minute automatic-login cooldown; temporary failures use the existing
60-second cooldown. Account verification must be completed through SportyBet.
Automation cannot promise uninterrupted access when the provider denies it.

Optional server tuning:

```text
SPORTYBET_REFRESH_SECONDS=1200
SPORTYBET_REFRESH_MARGIN_SECONDS=300
SPORTYBET_LOGIN_RETRY_MS=60000
SPORTYBET_SESSION_CHECK_MS=60000
```

The old encrypted API-login adapter is available only with
`SPORTYBET_BOOKING_MODE=session` and `SPORTYBET_LOGIN_METHOD=api`; its format is unverified and it is not used by
default. Cookie capture in [SPORTYBET_SESSION_RECOVERY.md](SPORTYBET_SESSION_RECOVERY.md)
remains an optional recovery tool if SportyBet requires human verification.

## Installing the archive on your Mac

After downloading this ZIP into Downloads:

```bash
cd ~/Documents &&
session_dir=$(mktemp -d /tmp/plot207-session.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-anonymous-booking.zip -d "$session_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$session_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Generate SportyBet booking codes without dummy login" &&
git push origin main
```

## Validation

The full Node test suite covers session recovery, build installation, public
cache collection, removed hourly QC/live schedules and retained next-12-hour ticket packs.
See [SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md](SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md) for this update's checks and installation.

Focused tests exercise expiry, proactive refresh, rotated refresh tokens,
concurrent recovery, rejected sign-in, private persistence and restart reuse.
The real server HTTP handlers recover a mocked revoked session, build fresh
live selections and create a mocked booking code without bootstrap updates.
Real Chromium also exercises the website-form adapter against a local test
page using fake credentials, including successful login and stopping at OTP
or a rejected password. These tests do not authenticate a real SportyBet
account, send a real Telegram message or change production settings.

The test environment used a temporary Chromium binary supplied through a
test-only executable override because the Playwright download CDN returned
incomplete archives. That temporary dependency is not part of this project;
production uses the pinned Playwright installation commands above.

The public SportyBet form was inspected to confirm its input names and Login
button. This establishes the adapter's selectors, not successful account
authentication on your server. Playwright's documented browser installation
commands are at [playwright.dev/docs/browsers](https://playwright.dev/docs/browsers).
