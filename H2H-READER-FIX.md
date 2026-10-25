# Public H2H reader deployment fix

The screenshots show that H2H was attempted but no fresh matching evidence was verified for those selections. They do not establish one specific Render failure. The previous code suppressed collector errors, so missing Chromium, missing system libraries, page timeouts and team-name mismatches all produced the same generic status.

A concrete installation defect was found: public booking mode skipped Chromium in postinstall even though the enabled H2H collector requires it. The installer now installs the pinned browser when H2H is enabled, regardless of booking mode. Explicit PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 still requires a prepared browser. Public data reads and booking remain anonymous; dummy credentials are not used for these checks.

H2H collection now reads visible embedded frame content as well as the main document. Hidden stale frames are excluded. Team identity still must be verified; missing pages are not silently accepted as history.

Each failed selection now receives a safe failure reason and user-facing explanation. Render logs one grouped `[SportyBet H2H]` summary per check batch with counts such as browser_missing, browser_dependencies, stats_tab_unavailable, h2h_panels_unavailable or team_identity_unverified. Raw exception details, paths and credentials are not exposed to the webpage. Existing unavailable-H2H eligibility, floors, check limits and ticket marking remain unchanged. Minute-specific totals do not borrow full-match historical averages.

Deploy with the build command `npm ci --ignore-scripts=false`. The build should report `Chromium is ready for public H2H checks and optional session recovery.` Generate a fresh ticket after deployment. If checks still fail, the label and grouped Render log now identify the next concrete issue. Installing Chromium does not guarantee SportyBet statistics are accessible from the Render host.

Validation: 528 non-browser tests pass, including the build decision, safe diagnostic classification, failed-check eligibility and visible-frame extraction. The updated headless reader has not been verified against SportyBet from Render. The older supplied football and basketball example pages now redirect to live pages in the inspected cloud browser, so they did not provide a current prematch H2H verification. No real booking or Telegram send was performed.
