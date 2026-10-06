# SportyBet-only update

- Removed the paid football and related results-provider clients and configuration requirements.
- Fixtures, odds, offered corner O/U lines and booking IDs come directly from SportyBet, attaching the configured dummy session.
- Added a bounded browser collector for the statistics displayed on SportyBet match pages, published through the existing internal-job secret. These are displayed goal averages and H2H, not a replica of the retired provider's seasonal database.
- Kept Poisson/H2H modelling where statistics exist and clearly labelled complete-market price estimates where they do not. Missing or incomplete data cannot create a 100% estimate.
- Live mode excludes upcoming/finished/unknown-status matches and reads fresh details for missing offered markets. Football models account for current score and time when available.
- Quick Cash uses late live matches with currently winning offered selections. All live legs require at least halfway through the match. Website and Telegram builds retain user probability settings; the four scheduled sport QC tickets use 0% and scheduled Live All Sports uses 85%. See `HOURLY_QC_AND_LIVE_RULES.md` for score, total, handicap and set-format rules.
- Booking generation checks current availability, progress and winning market state again, and reports dropped legs. Only booking/share codes are created; no stakes are submitted.

## Live feed correction

- Read all competitions in SportyBet's live array of tournaments instead of treating tournaments as matches.
- Recognize the actual `H1`, `H2`, `HT` and `Q4` phase codes, cumulative `setScore` and text clocks such as `63:57`.
- Exclude numeric suspended/settled market statuses and inactive outcomes. Keep full-match winner markets that include overtime; reject quarter/period winners and 1UP/combination markets when ordinary winners are requested.
- Preserve a 0% minimum probability and let the default all-leagues choice include every live SportyBet competition.
- Report source-game and ongoing-game counts. Corner diagnostics use live corner rows in live mode and no longer require a historical corner model.
- Share simultaneous live board reads across selected bet types within a current request; later user requests and booking validation read the board afresh.

## Setup

User-requested builds and analyses now read current SportyBet data without waiting for the daily refresh. See `SPORTYBET_ON_DEMAND.md` for the current request flow and the remaining role of the daily workflow.

Deploy the updated source, keep the dummy `SPORTYBET_PHONE`/`SPORTYBET_PASSWORD` on the server and also add them to GitHub Actions secrets. Keep `TELEGRAM_JOB_SECRET` synchronized between server and Actions. See `SPORTYBET_SETUP.md` for the collector command and optional session/proxy settings. Run the refresh workflow after deployment to replace retired prediction caches. Existing provider keys can be removed from deployment settings.

## Validation

200 Node regression tests passed. Syntax checks passed for all 58 source/test JavaScript files and the inline website script. HTTP integration tests cover current prematch/live Auto Analyser selection, user probability settings, hourly QC, Today’s Codes, live corners, exact imported fixtures, truthful empty-result diagnostics and the booking/Telegram flows with mocked services. Earlier fresh read-only SportyBet requests returned current games for all six sports, and a real HTTP build produced eligible selections without a daily snapshot. Authenticated statistics collection, real booking creation and real Telegram posting have not been exercised in this workspace; verify them after deployment.
