# Unified refresh patch (2026-09-18)

The real `.github/workflows/refresh.yml` now launches four independent jobs
in parallel from ONE scheduled event at 07:20 WAT / 06:20 UTC. All six sports
are covered by those jobs. Only this workflow schedules sport data collection.
The Handball, Volleyball, and Tennis workflow files remain available for
`workflow_dispatch` manual recovery but no longer have daily schedule entries.

The core job verifies saved predictions; the other sport jobs verify a fresh,
nonempty snapshot via each sport's status endpoint. The broken Handball status
endpoint's undefined `sets` variable was removed; this makes snapshot health
checkable without adding a new API. A collector may still fail if the provider
has no eligible fixtures or its extractor/publisher fails; a green workflow
cannot guarantee the website contains games without these checks.

Telegram remains a separate, once-per-day job at 08:25 WAT. No odds, models,
subscription settings, Telegram eligibility or sending logic were changed.

Deploy workflow files to GitHub default branch; deploy server.js to Render.
For an immediate one-off six-sport refresh, manually run the *single*
Daily Predictions Refresh workflow. Verify all four jobs green and check
website outcomes. Do not trigger Telegram manually if it already posted today.
