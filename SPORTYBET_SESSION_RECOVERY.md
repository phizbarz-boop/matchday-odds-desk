# Dummy-session recovery and optional manual bootstrap

This guide applies only to explicitly enabled `SPORTYBET_BOOKING_MODE=session`.
The current default generates codes anonymously and does not need cookie capture
or dummy-session renewal. See [SPORTYBET_ANONYMOUS_BOOKING.md](SPORTYBET_ANONYMOUS_BOOKING.md).

**Normal expiry is now automatic.** Set the dummy account phone/password and
install the server browser once using
[SPORTYBET_AUTOMATIC_SESSION.md](SPORTYBET_AUTOMATIC_SESSION.md). It covers the
Render build command, persisted token renewal and website-form re-login.
The steps below are optional recovery for a provider verification prompt or
an unavailable automatic login, not routine session maintenance.

The repeated `login returned 200 but no token/cookie` lines share one cause:
SportyBet did not issue an authenticated dummy-account session. HTTP 200 only
describes the transport response; `bizCode`, `message` and issued credentials
determine whether login succeeded. The logs alone do not identify why SportyBet
rejected it. The encrypted password-login adapter was based on an unverified
cipher assumption. It is now used only with `SPORTYBET_LOGIN_METHOD=api`.
The default browser method uses the website's own form and login JavaScript;
its visible form selectors were inspected on the current public site.

The session recovery paths support automatic website sign-in independently of
that legacy cipher adapter:

- Prefer the existing patron login candidate to the obsolete default users path;
  explicit endpoint overrides still take precedence.
- Preserve the device cookie across password login.
- Reject non-success `bizCode` responses even with HTTP 200 or a cookie present.
- Require an authenticated account check before Auto/Telegram market fan-out.
  Account checks share a 60-second validation interval, while sports boards still
  refresh on each analysis request.
- Share loading, checking, refreshing and login across concurrent market reads.
- Refresh before password login and retry the authenticated request once inside
  its original promise. The previous GET retry could await itself indefinitely.
- Detect local token expiry, cookie deletion and HTTP-200 expired-session errors.
- Do not accept a visitor device cookie or a refresh response without usable
  credentials as successful login.
- Back off temporary failed login attempts for 60 seconds and verification or
  rejected browser sign-in for 15 minutes. Production Auto
  Analyser returns HTTP 503 with `SPORTYBET_AUTH_FAILED` and a recovery message;
  authentication errors no longer become empty-market/corner diagnostics.
- Apply changed bootstrap cookies over stale persisted cookies/bearer tokens.
  Save a fingerprint so the same old bootstrap cannot overwrite a newer
  rotated session on every restart.

## Optional manual recovery on Render

1. Deploy the updated source. Keep the existing Redis and Telegram settings.
2. Log in to the dummy account through SportyBet Nigeria in your own browser.
   Complete any verification through SportyBet's form.
3. In Developer Tools, open Application/Storage → Cookies → www.sportybet.com.
   Copy the current `accessToken`, `refreshToken` and actual device cookie
   (`device-id` or `deviceId`) values directly
   into the Render environment value below. Do not share the values in chat.

   ```text
   SPORTYBET_BOOTSTRAP_COOKIES=accessToken=ACTUAL_VALUE; refreshToken=ACTUAL_VALUE; device-id=ACTUAL_VALUE
   ```

   In Render the environment key is `SPORTYBET_BOOTSTRAP_COOKIES`; its value
   begins with `accessToken=`, not with `SPORTYBET_BOOTSTRAP_COOKIES=`. The
   displayed ACTUAL_VALUE text is a placeholder, never a working credential.

4. Save and restart/deploy Render. The changed value replaces old persisted
   authentication; it does not require deleting Redis/session data.
5. Open the existing website diagnostics route `/api/sportybet/diagnostics`.
   After a successful check, `session.loggedIn` should be true,
   `session.lastAuthenticatedAt` should show a recent account check, and
   `publicDataProbe.ok` should be true. The probe now uses the configured dummy
   session. Cookie/token values are not included in diagnostics.
6. Run Auto Analyser live/QC and generate a booking code. The app-server hourly
   timer uses the same session. An authenticated manual QC/Live job can test
   Telegram delivery on your deployment.

`loggedIn` alone is a local credential check; use the verified timestamp and
successful probe to assess actual access. If the hosting IP is rejected,
SportyBet requires verification, or refresh is revoked, the application cannot
guarantee access and will keep the explicit session/source error visible.

## Optional local helper: capture the session without copying separate cookies

Run from the project folder on your own computer:

```bash
npm ci
npm run browser:download
node jobs/sporty-session-bootstrap.js
```

The helper opens a visible SportyBet browser. Sign in yourself, then press Enter
in the terminal. It checks the account and saves the current three session
cookies to `.sportybet-bootstrap.env` with owner-only file permissions. It does
not print the cookie values. It performs no wager or Telegram send. Copy the
text after the first `=` from that private file into the Render environment
value. On macOS you can open it locally with:

```bash
open -e .sportybet-bootstrap.env
```

The file is ignored by git and excluded from this source archive. Chromium is
used only for website-form sign-in and statistics collection; ordinary session
reads/refresh use HTTP. Keep phone/password configured on the server for
automatic re-login. The separate GitHub statistics collector installs its own
browser and uses its repository secrets.

## Validation and limitations

The regression suite includes actual server HTTP handlers with mocked SportyBet
responses. It reproduces rejected HTTP-200 login, demonstrates one login across
32 market families with zero board reads after rejection, and checks that a
fresh browser session can build current live QC selections and generate a code.
It also checks concurrent 401/expired-session recovery, stale bootstrap
replacement, rotated-session preservation, cookie expiry/deletion and secure
cookie export. Existing live policies, four sport-specific QC templates at 0%,
Live All Sports at 85%, Today's Codes and 12-hour ₦100 ROI reporting remain
covered by the earlier tests.

The automatic-recovery release adds real Chromium tests against a local login
form with fake credentials, including OTP and password rejection. It also
tests proactive renewal, rotated refresh tokens and restart reuse without a
bootstrap update. See `SPORTYBET_AUTOMATIC_SESSION.md` for the current setup.

These tests do not prove a successful live dummy login, real booking code or
Telegram delivery. No production deployment/account was changed here.

Optional tuning: `SPORTYBET_LOGIN_RETRY_MS=60000` and
`SPORTYBET_SESSION_CHECK_MS=60000`. The existing protected
`POST /api/sportybet/session/relogin` route explicitly tries password login
and can bypass the automatic cooldown; bootstrap recovery uses a changed
environment value plus restart/deploy instead.
