# Render build and SportyBet session fix

The later October 7 build confirms that Chromium installation succeeds.
For its remaining browser sign-in error, use the updated recovery and
diagnostics described in
[SPORTYBET_BROWSER_SIGNIN_FIX.md](SPORTYBET_BROWSER_SIGNIN_FIX.md).

The supplied Render log shows a successful deployment and running schedulers.
The `patron/refresh -> 404` line means the configured refresh route was not
found. Restoring cookies does not establish that SportyBet still accepts them.
The old build ran only `npm install` without a Chromium installation step.

## Changes in this archive

- `npm install` and `npm ci` now install the pinned Chromium browser through
  postinstall. A failed installation fails the build instead of leaving browser
  recovery unavailable at runtime.
- Build and browser entry points use the same package-local browser path by
  default. Explicit browser paths, including Docker's `/ms-playwright`, remain
  supported. Docker installs the browser and Linux libraries once during build.
- A 404/405 refresh response disables further calls to that route until restart.
  A still-accepted session remains usable; expiry or rejection triggers the
  shared browser login. Temporary server errors remain retryable.
- Hourly logs now include an outcome, such as `no_eligible_live_games`,
  `already_processed_this_hour`, or the fixed per-category outcome codes.
- The lockfile updates Express and its affected dependencies within their
  existing major versions to resolve the four audit findings.

The anonymous public cache still refreshes at 06:30, 12:30 and 17:30 WAT.
Next-12-hour packs still run at 07:00 and 18:00 WAT for 10,000, 2,500, 500 and
three 100-odds targets. Hourly QC/live delivery stays on the app server at :05
WAT, with the existing eligible-game rules and duplicate protection.

## One-time Render settings

Set these in the service environment, privately:

```text
SPORTYBET_PHONE=<dummy-account mobile number>
SPORTYBET_PASSWORD=<dummy-account password>
SPORTYBET_LOGIN_METHOD=browser
```

If already configured, retain them. Tokens alone cannot supply the phone number
and password needed for an automatic new sign-in. Keep existing Redis and
Telegram settings. Use Node 20 or newer, Build Command `npm install` (or
`npm ci`) and Start Command `npm start`. No extra browser-path setting is needed
for the native runtime. Do not disable npm lifecycle scripts for the native
build; Docker deliberately installs Chromium in its own explicit build step.

Deploy this archive's code. The new build should show
`[SportyBet browser] Chromium is ready for automatic session recovery.`
Use the website's session diagnostics to check `automaticReloginConfigured`,
`lastKeepAliveOk`, `lastAuthenticatedAt` and `requiresUserAction` after startup.
See [SPORTYBET_AUTOMATIC_SESSION.md](SPORTYBET_AUTOMATIC_SESSION.md) for the Mac
installation command and Docker fallback if the host lacks browser libraries.

## What `sent=0` establishes

It means that invocation posted no new ticket. It does not identify the cause
by itself. An already-processed hour and a successful read with no eligible
live matches can both finish with zero new tickets. Failed reads or booking
errors remain retryable. The new outcome log distinguishes these cases without
logging credential values or raw booking errors.

The scheduler's last run is also available in `/api/telegram/status`. The
account session is needed to create booking codes; anonymous public-cache
collection runs independently of account login. A scheduler startup line alone
does not establish that a cache refresh or ticket generation succeeded.

## Validation

All 309 Node tests pass, including the additional browser sign-in and cache
lease scenarios. The updated installed dependency tree reports zero
vulnerabilities in `npm audit`. The pinned Playwright CLI dry-run confirms
the browser destination is inside the deployed package.

Focused tests exercise actual npm postinstall execution using a local installer
fixture, shared browser recovery after a missing refresh route, preservation of
accepted sessions, temporary-error retries and safe empty-hour logs. Real
Chromium tests use a local sign-in page with fake credentials. These checks do
not sign into a real SportyBet account, send Telegram messages or deploy to
Render. SportyBet-requested account verification still needs to be completed
through SportyBet.
