# SportyBet browser sign-in and cache restart update

The current default uses anonymous booking without browser sign-in. The recovery
changes below remain available only for explicit `SPORTYBET_BOOKING_MODE=session`.
See [SPORTYBET_ANONYMOUS_BOOKING.md](SPORTYBET_ANONYMOUS_BOOKING.md).

For the subsequently identified `page_check` timeout, see
[SPORTYBET_PAGE_CHECK_FIX.md](SPORTYBET_PAGE_CHECK_FIX.md). The current archive
includes that fix alongside the changes described below.

The October 7 Render log confirms that the pinned Chromium installation now
succeeds and npm reports zero vulnerabilities. The remaining failure happens
after Chromium starts, inside automatic website sign-in. The previous generic
error did not identify which browser step failed, so it cannot establish a
password, provider, network or hosting cause.

## Changes

- Wait for SportyBet's phone, password and Login controls to become visible
  before entering the credentials. Enable the observed Keep me signed in
  checkbox when it is present.
- Give Chromium the same existing proxy configuration used by the SportyBet
  data client. No proxy is required or added automatically. Invalid proxy
  settings fail before credentials are entered.
- Retry one temporary account-verification HTTP/server or network failure
  without submitting the password again. Export cookies only after SportyBet
  accepts the account check.
- Report a fixed sign-in stage, reason, known network code, HTTP status and
  SportyBet business status when available. Raw Playwright errors, filled
  values, cookie values and proxy credentials remain private.
- Preserve these safe details across the shared login cooldown, Auto Analyser
  errors, session diagnostics and hourly-job status. Hourly failures now name
  their outcome instead of reporting `no_result_details`.
- Make the diagnostics public-data probe explicitly anonymous, independently
  of whether the dummy account is configured or currently authenticated.
- Replace the public cache's fixed one-hour running lock with a 15-minute
  lease renewed every 45 seconds. Check ownership before saving a snapshot;
  a worker that has lost its lease retains the last saved cache. Cache and
  schedule logs distinguish an occupied lock from a failed collection.

The public cache, hourly QC/live picks, daily picks and next-12-hour packs keep
their existing schedules, market rules and duplicate protection. A failed
cache refresh keeps the last readable snapshot.

## Deploy

Download `matchday-odds-desk-page-check-fix.zip` into Downloads, then run:

```bash
cd ~/Documents &&
signin_dir=$(mktemp -d /tmp/plot207-signin.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-page-check-fix.zip -d "$signin_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$signin_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Fix SportyBet page-check timeout during automatic sign-in" &&
git push origin main
```

Retain the existing private `SPORTYBET_PHONE`, `SPORTYBET_PASSWORD`, Redis and
Telegram environment settings. Browser sign-in remains the default; an
explicit `SPORTYBET_LOGIN_METHOD=browser` also selects it. Keep these Render
commands:

```text
Build Command: npm ci --ignore-scripts=false
Start Command: npm start
```

The native runtime still defaults to `PLAYWRIGHT_BROWSERS_PATH=0` and installs
the pinned browser during the build. Docker retains its prepared browser path.
This update does not require another bootstrap-cookie copy for ordinary expiry.
An old one-hour cache lock created by the previous version can remain until
its original expiry; new running locks use the renewable 15-minute lease.

## Read the next result

A verified new sign-in logs:

```text
[SportyBet session] Dummy account signed in through the browser; session saved automatically
```

If a browser step fails, its safe details appear in the error, for example:

```text
SportyBet login page navigation timed out. (stage=navigation)
SportyBet browser networking failed; recovery will retry after its cooldown. (stage=navigation, networkCode=ERR_PROXY_CONNECTION_FAILED)
SportyBet account verification returned an HTTP error. (stage=account_check, httpStatus=404)
```

These examples illustrate diagnostic formats; they do not predict your server's
failure. After unlocking website access if configured, check
`/api/sportybet/diagnostics`: `session.lastLoginFailure` contains the fixed
diagnostic fields, and `session.nextLoginRetryAt` shows the cooldown. The
anonymous `publicDataProbe` establishes public-data reachability separately.
`/api/sportybet/public-cache/status` shows the cache's latest collection and
schedule outcome; `/api/telegram/status` shows the hourly job result.

Temporary login failures remain eligible for automatic retry after the existing
60-second cooldown. Background maintenance checks every four minutes and the
hourly job retries failures every two minutes. An actual OTP or browser
verification prompt still needs completion through SportyBet; the adapter
reports that separately and does not submit the password repeatedly.

## Validation

All 319 Node tests pass. Checks also passed for 80 JavaScript files, the inline
website script, 13 workflow YAML files and Git whitespace. `npm audit` reports
zero vulnerabilities.

Real Chromium tests use a local form and fake credentials. They cover delayed
controls, a temporary account-check outage, successful verified sign-in,
rejected credentials, OTP, denied-page HTTP status and a missing account-check
route. Integration tests verify the safe metadata in the real server handlers
and hourly job, the anonymous probe, shared cooldown, and cache lease recovery.
The test-only Chromium binary is outside the project; deployment continues to
use the pinned Playwright browser.

Real SportyBet account authentication from Render has not been verified here.
This archive has not been pushed or deployed, and the tests do not send real
Telegram messages or place wagers. The next deployment's diagnostic result
will identify the failing step if provider authentication still fails.
