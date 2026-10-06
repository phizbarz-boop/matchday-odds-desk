# SportyBet-only update

- Removed the paid football and related results-provider clients and configuration requirements.
- Fixtures, odds, offered corner O/U lines and booking IDs come directly from SportyBet, attaching the configured dummy session.
- Added a bounded browser collector for the statistics displayed on SportyBet match pages, published through the existing internal-job secret. These are displayed goal averages and H2H, not a replica of the retired provider's seasonal database.
- Kept Poisson/H2H modelling where statistics exist and clearly labelled complete-market price estimates where they do not. Missing or incomplete data cannot create a 100% estimate.
- Live mode excludes upcoming/finished/unknown-status matches and reads fresh details for missing offered markets. Football models account for current score and time when available.
- Added Quick Cash in the website and Telegram builder: late live matches with a current leader, user probability limits and selected side markets. Scores and phase must be readable. Football starts at 75 minutes; basketball Q4/overtime; hockey final period/overtime; handball 50 minutes in the second half.
- Booking generation checks current availability and Quick Cash leaders again, and reports dropped legs. Only booking/share codes are created; no stakes are submitted.

## Setup

Deploy the updated source, keep the dummy `SPORTYBET_PHONE`/`SPORTYBET_PASSWORD` on the server and also add them to GitHub Actions secrets. Keep `TELEGRAM_JOB_SECRET` synchronized between server and Actions. See `SPORTYBET_SETUP.md` for the collector command and optional session/proxy settings. Run the refresh workflow after deployment to replace retired prediction caches. Existing provider keys can be removed from deployment settings.

## Validation

104 Node regression tests passed. Syntax checks passed for all 24 library/job/server JavaScript files and the inline website script. Tests use mocked SportyBet responses and cover parser accuracy, incomplete price sets, corner availability, live score/time conditioning, finished matches and changing Quick Cash leaders. Authenticated collection and real booking creation have not been exercised in this workspace; verify them with the configured dummy account after deployment.
