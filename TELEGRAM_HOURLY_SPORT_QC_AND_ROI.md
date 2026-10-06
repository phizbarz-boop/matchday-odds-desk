# Telegram hourly sport QC and 12-hour results

The scheduled 2x and 3x tickets and the three 1000-target sport tickets are retired. The morning SAFE ticket remains at 08:25 WAT, with its existing 85% probability floor and 1.30–5.00 odds range. Interactive website and Telegram builder odds choices remain user-controlled.

## Hourly tickets

The workflow **Plot207 Telegram Hourly QC and Live Picks** runs every hour at **:05 WAT**. It requests the protected `/api/telegram/quick-cash` endpoint and creates up to five separate booking codes:

| Ticket | Sport pool | Minimum probability | Match stage |
| --- | --- | --- | --- |
| QC ICE HOCKEY | Ice hockey | 0% | Final period / overtime |
| QC BASKETBALL | Basketball | 0% | Fourth quarter / overtime |
| QC HANDBALL + VOLLEYBALL | Handball and volleyball | 0% | Handball 50+ minutes in H2; volleyball proven deciding set |
| QC FOOTBALL | Football | 0% | Regulation 75+ minutes |
| LIVE ALL SPORTS 85% | Football, basketball, ice hockey, handball, volleyball, tennis | 85% per selection | At least halfway |

Every selected bet must already be winning against its actual offered score, total, corner or handicap line. A match lead alone does not establish a winning handicap or total. Live 85% considers every currently supported bet type, including winner, totals, corners, double chance, DNB, BTTS, Asian handicap and correct score where available. Removed 1UP and first-half team-corner types remain removed. Missing progress, metric or line data excludes a selection.

These jobs require an authenticated dummy SportyBet session. A device/visitor cookie is not sufficient. Configured login failures propagate instead of silently using anonymous live data. Current markets come from SportyBet; no paid football provider is used. The code checks scores and availability again, then recomputes the selected market probabilities from another fresh read before creating a code. An earlier 85% estimate cannot qualify a newly lower-probability selection.

Each ticket keeps the existing flexible combined-odds goal of 2.00 and maximum 15 distinct fixtures by default. These are goals/caps, not a requirement to generate every game in the scan. A qualifying single selection at 10.00 odds can produce a 10.00 ticket. A combination below the goal can also be sent. A category with no eligible games is skipped; empty tickets are never sent. No monetary bets are placed.

Optional settings:

- `TELEGRAM_QC_TARGET_ODDS` and `TELEGRAM_QC_MAX_SELECTIONS`: default 2 and 15 for each of the four QC categories.
- `TELEGRAM_LIVE_TARGET_ODDS` and `TELEGRAM_LIVE_MAX_SELECTIONS`: default 2 and 15 for Live 85%.
- Both maximum-selection settings are capped at 40.
- Probability floors are fixed at 0% / 85%, regardless of request-body settings.

Each category has its own shared per-WAT-hour lock. A retry cannot re-send a completed or ambiguous-delivery ticket. Unsent failures can retry independently; a partial batch returns a failure status for the workflow instead of claiming complete success. New hours read the board again.

## Today’s Codes

Every hourly code is stored under its category and WAT hour in a separate Redis hash field, so five simultaneous categories cannot overwrite one another. The morning SAFE write cannot erase hourly history. Today’s Codes shows SAFE plus all five hourly categories to Free, Pro and Elite. Retired scheduled 2x/3x/1000 templates are hidden from the list.

## 12-hour result and ROI report

The workflow **Plot207 Telegram 12-Hour Results and ROI** runs at **00:10 and 12:10 WAT**. It requests `/api/telegram/performance-report` and reviews the preceding completed WAT half-day: 12:00–00:00 or 00:00–12:00. It also refreshes unresolved earlier tickets and shows their newly confirmed results by code.

The Telegram message contains:

- Number of sent tickets, wins, losses, voids, partial returns/losses and pending tickets.
- Confirmed winning ticket categories and codes, with hypothetical returns.
- Closest shot and worst fully resolved losing/partial-loss ticket, ranked by successful legs / total legs (voids and half wins counted as successful). Pending legs are excluded from this ranking.
- Up to ten distinct confirmed winning selections, with the additional count when there are more.
- Total stake, confirmed returns, profit/loss, ROI and unresolved stake for the half-day, plus totals for all retained tracked sent tickets.

The calculation assumes **₦100 per successfully sent ticket**, including the retained morning SAFE. It uses the saved selection prices and confirmed SportyBet settlements or final score/statistics. Availability status numbers and live “winning” flags cannot establish a settled win. Unknown result codes, abandoned matches without an official settlement, missing final corner counts and incomplete final set/game/point histories stay unresolved. Regulation markets require a regulation score when the result includes extra time.

For each leg, the returned stake multiplier is its saved odds for a full win, 0 for a full loss, 1 for a void/push, (odds + 1) / 2 for a half win, and 0.5 for a half loss. Accumulator returns multiply these factors. This prevents an original voided leg’s price from inflating a winning ticket’s payout. A confirmed overall SportyBet settlement takes priority; an overall win without enough information to price void/half-settled legs remains a win with an unresolved return.

Profit/loss = confirmed returns minus the stake of priced settled tickets. ROI = that profit/loss divided by that settled stake, multiplied by 100. Unresolved stake is displayed separately and never counted as a loss. The figures are hypothetical gross returns before taxes or bonuses. Unconfirmed Telegram delivery is excluded from played-stake totals. If the dummy session or some results are unavailable, the update labels the missing confirmation and keeps unresolved outcomes pending.

Ticket records use individual Redis hash fields, retaining the old tracker’s records without allowing hourly, daily and report workers to overwrite each other. A repeated booking code sent in different hours counts as a separate ticket each time, because the stated assumption is ₦100 for every sent ticket. Result lookups share identical booking/event reads within one report, prioritize the report window, and limit a scan to 500 tickets / 12 minutes; any remaining unresolved tickets can be checked in later reports. Previously confirmed results are retained if an old result becomes unavailable.

## Activate after installation

Use the existing `REDIS_URL`, dummy SportyBet credentials or bootstrap session, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and shared `TELEGRAM_JOB_SECRET`. Keep `TELEGRAM_JOB_SECRET` synchronized between Render and GitHub Actions secrets. No new required secret is introduced. `MATCHDAY_BASE_URL` can be set as a GitHub repository variable; the existing Render URL is the default.

Push the updated source and wait for Render deployment. In GitHub Actions, run **Plot207 Telegram Hourly QC and Live Picks** and **Plot207 Telegram 12-Hour Results and ROI** to verify the live deployment. The report’s manual run uses the last completed WAT half-day and is deduplicated with that half-day’s scheduled report. GitHub scheduled starts may be delayed; the picks use data read at actual execution time.

## Validation

200 Node tests pass, with syntax checks for all 58 project JavaScript files and the inline website scripts. HTTP integration tests exercise the real server with mocked SportyBet, Redis and Telegram services. Coverage includes isolated sport pools, 0%/85% filtering, changed odds and score revalidation, hourly/category deduplication, partial-batch retries, Today’s Codes visibility/history, exact settlement matching, pushes, quarter-lines, missing results, WAT report windows, closest/worst ordering, earlier-ticket updates and ₦100 ROI arithmetic.

These tests do not create real SportyBet booking codes or send real Telegram messages. This archive is source ready for deployment; the user’s GitHub/Render deployment has not been changed from this workspace.
