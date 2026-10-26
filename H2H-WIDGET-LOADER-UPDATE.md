# H2H widget loader compatibility update

## What the supplied capture proves

The sr:match:72123488 capture from GitHub run 40300751751 shows both tabs and an empty statistics content area. It records net::ERR_BLOCKED_BY_ORB for the public Sportradar widgetloader script used by SportyBet. The screenshot agrees with the report: neither panel has rendered. There is no evidence of missing historical records in this capture; the script itself failed to load. The capture alone does not establish what response caused Chromium to block it or whether the hosting network is responsible.

A separate public HTTP check returned status 200 and JavaScript for that loader from this environment. That does not establish what the GitHub browser received.

## Changes

- The external worker uses full Chromium. GitHub runs it in headed mode under Xvfb, rather than using the separate headless shell. Browser security remains enabled. No proxy, dummy login or new paid service is introduced.
- When neither panel loads and the recorded loader failure is ORB, the result is h2h_widget_loader_blocked rather than a generic selector error.
- Three consecutive loader blocks stop a batch, leaving fixtures queued for a later run. No history or green H2H label is invented.
- Diagnostics now retain the widget loader response status and content type, including successful HTTP responses. URL queries, response bodies and request credentials are not captured.
- Website and Telegram analysis continue to use saved Redis history. Missing H2H evidence keeps the original estimate and remains unverified.

Full Chromium is an evidence-directed compatibility attempt, not a confirmed fix for the GitHub network response. References: https://playwright.dev/docs/browsers and https://playwright.dev/docs/ci .

## After pushing the update

Keep SPORTYBET_H2H_ENABLED=false on Render. No Render environment change is needed.

Start a NEW Actions → Plot207 H2H History Worker run on the updated main branch. Set event_id to sr:match:72123488 for one fixture, or leave it blank for current fixtures if this event is no longer queued/upcoming.

Success means the worker summary shows saved greater than zero. Finding the H2H tab alone is not success. If it still fails, download the new h2h-panel-debug-<run-id> artifact and share the JSON report. It will distinguish a loader block from a panel parsing failure and retain response content type when Chromium exposes it.

No production Redis writes, booking or Telegram sends were performed during development. Automated tests use mocks; only a new GitHub run can establish whether this browser change restores the public widget there.
