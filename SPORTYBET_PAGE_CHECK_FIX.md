# SportyBet page-check timeout fix

The October 7 log from commit `99417f6` confirms a successful Chromium build
and a running application. The sign-in failure is now identified as
`browser_page_timeout` at `stage=page_check`, with login-page HTTP status 200.
That check runs before the adapter enters the dummy-account credentials.

The previous adapter read the entire body's rendered text with a three-second
deadline while checking for verification and rejected-login messages. A local
slow-page test reproduces that timeout. The supplied Render log does not expose
the browser DOM or prove why its page content was slow to become readable.

## Change

- Remove the full-body rendered-text read. Inspect visible OTP inputs and
  matching verification or sign-in-error messages with targeted locators.
- Allow the body up to 15 seconds to attach before checking it.
- Retry one temporary page-check timeout within the existing 90-second
  overall sign-in limit. Complete all checks before entering credentials;
  a second timeout fails with its specific diagnostic fields.
- Repeat the checks after the login controls finish loading, immediately
  before filling the account fields. Verification that appears during loading
  still stops automatic sign-in.
- Preserve OTP, CAPTCHA/browser-verification and rejected-account stops.
  Hidden error templates and script text do not trigger visible-message stops.
- Add fixed `pageCheck` and `pageCheckAttempt` fields to safe error messages,
  session status, Auto Analyser responses and hourly-job status. No page text,
  entered credentials, tokens or raw Playwright errors are included.

The new page-check identifiers are `body_ready`, `verification_inputs`,
`verification_messages` and `rejection_messages`. Attempt numbers are 1 or 2.
A persistent timeout can now report, for example:

```text
A SportyBet browser step timed out. (stage=page_check, pageCheck=body_ready, pageCheckAttempt=2, httpStatus=200)
```

This is an example of the new diagnostic format, not a predicted Render result.
The prior session, proxy, public-cache and booking changes remain included.
The hourly clock, public-refresh times, next-12-hour packs and selection rules
continue through the same application jobs.

## Deploy from your Mac

Download `matchday-odds-desk-page-check-fix.zip` into Downloads, then run:

```bash
cd ~/Documents &&
pagecheck_dir=$(mktemp -d /tmp/plot207-pagecheck.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-page-check-fix.zip -d "$pagecheck_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$pagecheck_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Fix SportyBet page-check timeout during automatic sign-in" &&
git push origin main
```

Keep the Render Build Command `npm ci --ignore-scripts=false` and Start Command
`npm start`. Retain the existing private dummy-account, Redis, Telegram and
proxy settings. Ordinary expiry recovery still uses automatic website sign-in
and saved sessions.

A verified new sign-in logs:

```text
[SportyBet session] Dummy account signed in through the browser; session saved automatically
```

After unlocking website access if configured, `/api/sportybet/diagnostics`
shows `session.lastLoginFailure`, `lastAuthenticatedAt` and `nextLoginRetryAt`.
`/api/telegram/status` shows the hourly result. A first-party login page returning
HTTP 200 alone does not establish account authentication or ticket delivery.

The event-detail lines in the supplied log are separate: the first candidate
returned 404, and the resolver then selected `/factsCenter/event`. That fallback
completed; the log does not show an event-detail failure after resolution.

## Validation

All 319 Node tests pass. Syntax checks passed for 80 JavaScript files and the
inline website script, 13 workflow YAML files parsed, Git whitespace checks
passed, and `npm audit` reports zero vulnerabilities.

Real Chromium tests use a local website and fake credentials. They reproduce
the old three-second body-read failure, verify a successful slow-page login,
exercise a 3,000-row odds board with hidden warnings, and confirm that visible
verification prompts stop before a password submission. Other tests check
one-time recovery, a persistent two-attempt failure, verification appearing
during retry or form loading, and safe metadata through the server and hourly
job cooldown. The test-only Chromium binary is outside this archive; deployment
continues to use the pinned Playwright browser.

Real account authentication from Render has not been tested here. The archive
has not been pushed or deployed, and tests do not send real Telegram messages
or place wagers. If the provider still prevents sign-in after deployment, the
new diagnostic fields identify the specific check that failed.
