# SportyBet booking without dummy login

The app now creates SportyBet booking codes through the public website's
anonymous Book Bet sharing operation. The default mode is `public`, including
when old dummy credentials or an expired private session remain on the server.
No access token, refresh token or browser-cookie renewal is needed for this flow.

For the latest Telegram workflow and deployment update, see
[TELEGRAM_AUTO_PICK_FIX.md](TELEGRAM_AUTO_PICK_FIX.md). Anonymous booking remains
the default in that update.

## Live verification

On 7 October 2026, SportyBet's Nigeria website generated test reservation code
`RF33A7` in a logged-out browser. A separate server request with no Cookie or
Authorization header returned the same code. The updated app's booking function
also returned it with `session.loaded=false` and `loginCount=0`. Its public code
lookup then returned the matching selection without loading a session.

The test used one football match and the offered home-win selection. These
checks establish anonymous sharing and lookup for that valid selection. Other
sports, market lines, live checks and Telegram paths are covered by local
regression tests. No monetary stake, real account sign-in, Telegram delivery or
Render deployment was performed. A booking code is a slip reservation.

## Request format

The app uses the same JSON format as the website:

```http
POST https://www.sportybet.com/api/ng/orders/share
Content-Type: application/json;charset=UTF-8
Current-Country: NG
```

```json
{
  "selections": [
    {
      "eventId": "sr:match:66887056",
      "marketId": "1",
      "specifier": null,
      "outcomeId": "1"
    }
  ]
}
```

Selections retain their real offered IDs and line specifiers. No stake, private
session header or app-only selection metadata is included. Lookup uses
`GET /api/ng/orders/share/<encoded-code>`, matching the public website's current
format. The old query-string lookup remains an explicit compatibility option.

A rejected public request is reported without falling back to dummy login.
Invalid, suspended or removed selections cannot produce a code. Network or
provider errors do not imply successful booking; a lost booking response keeps
its original uncertain status rather than automatically submitting again.
Public cache collection remains read-only and cannot create booking codes.

## Render configuration

Keep the existing Redis, Telegram and website-access settings. Use:

```text
SPORTYBET_BOOKING_MODE=public
SPORTYBET_CURRENT_COUNTRY=NG
```

Both settings default to these values. Dummy credentials can remain private on
the service, but public reads and booking do not load or send them. The protected
legacy relogin endpoint returns HTTP 410 in public mode.

Build command: `npm ci --ignore-scripts=false`.
Start command: `npm start`.

Postinstall skips Chromium in public mode. The optional public football
statistics browser can still be installed with
`npm run browser:download -- --force`, or `npm run browser:install` for Linux
dependencies. Explicit `SPORTYBET_BOOKING_MODE=session` restores the older
account adapter and its browser installation; see `SPORTYBET_AUTOMATIC_SESSION.md`.

After deployment, diagnostics should show `bookingMode: "public"`,
`bookingLoginRequired: false` and `authenticationScope: "none"` in the session
object. A private `loggedIn` value is not required for anonymous booking.

## Features retained

- Public on-demand analysis, all six sports and supported corner markets.
- Live/QC probability and currently-winning selection rules, plus a fresh public
  market check before live booking.
- Recoverable asynchronous booking and read-only status polling after a slow
  or lost HTTP connection.
- Daily SAFE, twice-daily next-12-hours Telegram targets, public cache refreshes,
  existing ticket history and results/ROI reports.
- Removal of hourly Telegram QC and live picks remains in effect.

## Install on your Mac

Download the new ZIP into Downloads. If the download has a numbered suffix,
use that exact filename in the `unzip` command:

```bash
cd ~/Documents &&
update_dir=$(mktemp -d /tmp/matchday.XXXXXX) &&
unzip -q ~/Downloads/matchday-odds-desk-anonymous-booking.zip -d "$update_dir" &&
rsync -a --delete --exclude=.git --exclude='.env*' --exclude=node_modules --exclude=data --exclude='.sportybet-*' "$update_dir/matchday-odds-desk/" matchday-odds-desk/ &&
cd matchday-odds-desk &&
git add -A &&
git commit -m "Generate SportyBet booking codes without dummy login" &&
git push origin main
```

The excludes preserve local secrets, installed dependencies, saved data and Git
history. Wait for Render to deploy the commit, then reload the website. This
download has not changed the running Render service.

## Validation

All 343 Node tests passed with no skipped tests, including exact anonymous
payloads, absent account headers, unchanged saved sessions, missing credentials,
public authentication failures without login fallback, lost responses, code
lookup, slow HTTP booking/resume, retained SAFE and next-12-hour plans, public
results/ROI, and live/QC booking. The optional legacy adapter is tested with
fake credentials and local Chromium fixtures. Syntax checks passed for 84
JavaScript files and the inline website script; all 12 workflows parsed.
