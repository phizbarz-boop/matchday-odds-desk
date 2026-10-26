# H2H panel reader update

The supplied GitHub run checked 19 fixtures and saved none: 18 had h2h_panels_unavailable and one had h2h_read_failed. This establishes that the worker had data and reached the reader, but not which tab-loading step failed. No verified history was available from that run.

The public Brentford vs Nottingham Forest example was inspected through SportyBet's mobile UI. Both H2H tabs were accessible, and the new panel displayed total corners 8.88, goals 2.50 and an eight-match season sample. That confirms public history for that example; it is not verification of the deployed headless GitHub collector or the 19 other fixtures.

Changes:
- Tab navigation and panel reading both search the main document and visible embedded frames. Previously only panel text reading searched frames.
- The H2H(New) label accepts harmless whitespace/case differences. Only visible controls are clicked.
- The new summary is attempted first. A missing old tab does not discard a usable new summary. Old panel capture rejects the new summary's headings so the same panel is not counted as both views.
- Missing tab controls and unreadable panel content produce different reason codes. Per-fixture logs include event IDs, stage and old/new tab/panel booleans when available, without credentials or raw page contents.
- Per-fixture cancellation allows up to 60 seconds. The eight-minute worker budget and 15-minute GitHub job limit remain.
- New manual workflow dispatches bypass the 15-minute failed-read cooldown, without deleting history. Scheduled runs still respect it.

Deploy the ZIP and start a NEW Plot207 H2H History Worker run from the updated main branch. Re-running an older failed job can execute the old commit. Keep SPORTYBET_H2H_ENABLED=false on Render and leave the existing GitHub REDIS_URL secret in place. No browser was moved back to the web process.

Verify the final saved count. If it stays zero, inspect the new [H2H reader] and [H2H fixture failed] lines to identify missing tabs versus missing content and the affected sports/event IDs. A passing test suite is not proof of successful production collection.

Validation: 548 non-browser tests pass, including embedded/main-document tab navigation, spaced labels, partial new-only evidence, cancellation and manual retry after a failed read. The GitHub workflow YAML and JavaScript syntax checks passed. No production Redis writes, workflow run, deployment, booking or Telegram send was performed.
