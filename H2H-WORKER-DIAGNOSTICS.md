# H2H worker diagnostic update

The reported logs find both H2H tabs but do not find recognized panel content. This is not proof that historical data is unavailable. The public page for sr:match:72123488 was checked manually and showed a 6.2 total-goals average and season samples of 17 and 16 games. The GitHub worker failure has not yet been reproduced with a captured page.

This update captures the actual failed public page in manual GitHub runs, including bounded page text, a viewport screenshot, panel diagnostics and failed network endpoints. Request headers, bodies, credentials and URL query strings are not recorded. Up to three failures are saved; artifacts expire after three days. Scheduled runs do not save captures.

## Run the diagnostic

1. Push this update to GitHub.
2. Open Actions → Plot207 H2H History Worker → Run workflow. Start a new run on the updated main branch; do not rerun an old commit.
3. Enter sr:match:72123488 in the optional event_id input. Alternatively leave it blank to check the current queue.
4. Open the completed run and scroll to Artifacts. Download h2h-panel-debug-<run-id>.
5. Share the JSON report and screenshot for a failed fixture so the actual runner page can be inspected. Do not share Redis credentials.

If the result says diagnostic_fixture_not_queued, that fixture has expired or is absent from the shared cache. Leave event_id blank and start another new run to inspect current fixtures.

Keep SPORTYBET_H2H_ENABLED=false on Render and retain the existing shared GitHub REDIS_URL secret. Browser collection stays in the GitHub worker; the website and Telegram read cached evidence. Missing H2H still does not remove a match or count as verified evidence.

The worker now checks queued sports in round-robin order. This prevents a long ice hockey queue from using the whole run before other sports are considered. It does not change the probability model or floors.

Validation: 553 tests passed, with the browser-login integration test file excluded. New coverage checks diagnostic capture/redaction, sport ordering and single-fixture selection. These tests do not establish that the live GitHub runner can read the panels; the new artifact is needed for that.
