# Run all Telegram pick types manually at any time

**Matchday Telegram Auto Picks → Run workflow** now runs the morning SAFE
template and the five hourly templates immediately. A manual trigger is not
restricted to 08:25 or the direct server's hourly schedule. The previous workflow only called
the daily SAFE endpoint, which explains why the manual run sent the 1.3-odds code.

| Manual daily workflow attempts | Probability floor |
| --- | --- |
| SAFE, combined odds range 1.30–5.00 | 85% |
| QC ICE HOCKEY | 0% |
| QC BASKETBALL | 0% |
| QC HANDBALL + VOLLEYBALL | 0% |
| QC FOOTBALL | 0% |
| LIVE ALL SPORTS | 85% |

The manual daily workflow has two steps: SAFE, then the five-template live batch.
The live step still runs when SAFE fails, unless the workflow is cancelled. The
workflow has enough time for both requests and uses the same configured
`MATCHDAY_BASE_URL` for both.

Running **Plot207 Telegram Hourly QC and Live Picks → Run workflow** manually
also requests all five live templates immediately. Each new manual workflow
run/rerun can generate fresh tickets in the same hour, even after the scheduled
batch was posted. Scheduled hourly/daily locks remain independent, so manual
runs do not consume later scheduled sends.

All templates use current SportyBet dummy-session data and revalidate before
creating codes. Manual triggering changes the time when the templates run; match
and market eligibility still apply. Live games must be ongoing, at least halfway
through, and the selection must already be winning under the offered market and
line. QC additionally requires its late stage. All five types are evaluated;
a category with no qualifying available games cannot produce a booking code.
The live response in the GitHub step log lists each category's sent/skipped/error
result, so fewer codes are distinguishable from an uncalled live batch.

## Today’s Codes and the 12-hour report

Manual QC/live codes are labelled MANUAL and saved as separate fields in Today’s
Codes. Multiple manual batches in the same hour cannot replace one another or
the scheduled hour's codes. Each sent manual QC/live ticket also gets its own
tracking ID, so the 12-hour report counts another hypothetical ₦100 stake for
each successfully sent ticket. Ambiguous Telegram delivery remains unresolved
and excluded from played-stake totals.

Manual live workflow requests include the GitHub run ID and attempt. A repeated
HTTP request for the same attempt reuses its scope, preventing duplicate sends.
Unsent failed categories can retry without sending categories that were already
posted; unknown deliveries remain protected. A new workflow run or intentional
GitHub rerun gets a fresh manual scope. Authenticated manual API callers can use
`x-matchday-run-mode: manual` and a stable `x-matchday-run-id` for the same retry
protection; the normal Telegram job secret is still required.

## Apply and verify

1. Install the updated source, commit and push it to GitHub.
2. Wait for Render to deploy the updated server. Keep existing Redis, Telegram
   secrets and the working dummy-account session settings.
3. In GitHub Actions, open **Matchday Telegram Auto Picks** and select **Run
   workflow**. Wait for both the SAFE and manual QC/live steps to finish.
4. Verify current eligible codes arrive in Telegram and appear in Today’s Codes.
   You can start another manual run in the same hour; it requests fresh data and
   tickets again.

Morning SAFE remains at 08:25 WAT and performance reports at 00:10/12:10 WAT.
The five hourly categories now run directly in the app server at :05 WAT by
default; the hourly GitHub workflow is manual-only. The manual pick workflow
does not trigger an additional performance report. See
[TELEGRAM_DIRECT_HOURLY.md](TELEGRAM_DIRECT_HOURLY.md) for activation and the
always-running server requirement.

## Validation

The combined manual/direct-hourly release passes 244 Node tests, syntax checks
for all 66 JavaScript files and the inline website script, Telegram workflow
YAML parsing and `git diff --check`.

Tests execute the workflow curl scripts against local mock HTTP handlers and
verify the manual/scheduled headers and live-step continuation after a failed
SAFE response. Actual application HTTP handlers are tested with mocked
SportyBet/Telegram/Redis services: a scheduled batch and two manual batches in
one hour each produce all five eligible categories, with 15 separate ticket
records and 10 distinct manual Today’s Codes fields. They also cover retry IDs,
hour boundaries, per-category partial failures, unknown delivery, authorization
and hypothetical ₦100 ROI tracking.

No real GitHub workflow was triggered, Telegram message sent or production
deployment changed from this workspace.
