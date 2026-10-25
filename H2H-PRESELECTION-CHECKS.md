# Public H2H checks before automated selection

This release connects a fresh public mobile H2H reader to the website Auto Builder, Telegram AI builder, imported-code analysis and automatic daily packs. Both H2H and H2H(New) are opened before a fixture passes the history check. An updated probability floor is applied afterwards. Daily validation checks history again before booking, including unfinished cached tickets.

What it does:
- Reads both public H2H views without dummy credentials, verifies the displayed teams and keeps an event-specific snapshot for at most 15 minutes. Restarting a host can cause a fresh read; membership and Today's Codes storage are untouched.
- Supports attempts for football, basketball, tennis, handball, hockey and volleyball through their mobile event pages. An event-ID route was verified against the supplied football example. Other sports use the same observed route pattern and their displayed team identities must match.
- Separates the new season summary from league and individual-team numbers. For example, the corner total is 15.11, not 8.00 or 7.11, and league averages are not substituted for match evidence.
- Parses dated previous results, excluding future and older-than-one-year entries, and removes duplicate date/participant records across views. Tennis set results do not become game totals.
- For comparable full-match football/handball goal, corner and card half-line totals, with at least five season matches per team, applies a conservative season-average Poisson probability cap. This can lower an odds-derived estimate but never increase it. The probability used by Telegram's floor, quality ceiling, edge and EV fields are updated together.
- For basketball/hockey full-match totals with sufficient season samples, flags an adverse mean-versus-line conflict. It does NOT pretend that an average alone determines a win probability or that regulation and overtime distributions are interchangeable.
- For other markets, insufficient samples, player props, shots on target, goal kicks, scoring-order streaks, unsupported periods and unknown distributions, explicitly records that there is no comparable historical adjustment. Such a check is page verification, not proof that the original probability has been statistically validated. Missing or unreadable H2H views prevent automated selection.

Coverage and limits:
- This is a preselection evidence check, not a fully calibrated all-sport statistical model. Winner/surface models, per-player models, period models, empirical distribution fitting and stronger H2H/form weighting still require further implementation and validation. Existing manual fixture cards are not rebuilt with this new checker; the automated builders and imported-code analysis use it.
- At most 40 different fixtures per request are checked by default, interleaved across sports, using two browser contexts at a time and a 90-second scheduling budget. A read already in progress may finish after the scheduling budget. Unchecked fixtures cannot pass as verified. Partial coverage can reduce ticket sizes; available alternatives are revalidated by the existing daily pipeline.
- No profit or accuracy improvement has been backtested for this cap. Averages alone do not establish profitability. Model assumptions and data-availability statuses are retained on checked selections.
- Live and Quick Cash candidates also require history access, but this release does not add a new live remaining-time H2H distribution.

Deployment:
- Requires the existing Playwright Chromium installation and operating-system browser dependencies on Render. The existing postinstall/browser setup remains in use. If Chromium or public statistics fail, the fixture is excluded instead of silently using old odds-only confidence.
- SPORTYBET_H2H_MAX_FIXTURES can change the 40-fixture limit. SPORTYBET_H2H_FILE optionally selects the snapshot path. SPORTYBET_H2H_ENABLED=false explicitly bypasses these checks; mocked-provider tests use that flag so their unrelated API/booking fixtures do not launch a browser. Do not set it to false when deploying this feature.
- The website result/status API exposes H2H coverage. History states distinguish missing/stale views, insufficient samples, unavailable market-specific metrics, mean conflicts and probability caps.
- Existing scheduled times, ticket types, probability floors, exclusions and booking limits are unchanged. Start a NEW manual workflow run after deploying; completed scheduled slots are not reopened.

Validation:
- The complete non-browser suite passed 510 tests on the final implementation, including the dependent-probability-field correction. Coverage includes the 15.11-corners example, stale/mismatched/missing evidence, sample limits, market-scope protection, basketball mean conflicts and pipeline errors.
- Both old/new views were inspected directly on the supplied football, basketball, tennis, handball and hockey pages. Local Chromium could not be installed in this workspace because its download returned a corrupt archive, so the new production headless collector has NOT been exercised end-to-end here. Deployment verification on the prepared Render runtime is still required. No real bookings or Telegram messages were sent.
