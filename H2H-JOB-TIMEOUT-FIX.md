# H2H workflow timeout headroom

The supplied GitHub annotation explicitly reports that collect-h2h exceeded its maximum execution time of 15 minutes. That job limit covered checkout, Node/dependency setup, browser/system installation, public discovery and H2H collection together. The worker's own 11.5-minute budget starts only when its Node process begins.

The GitHub job limit is now 30 minutes. The collection step has a separate 14-minute ceiling, leaving headroom beyond the worker's 11.5-minute budget for cleanup. The internal budget, automatic schedule, per-fixture persistence and retry queue remain unchanged. This change does not make each collection run last 30 minutes.

Discovery succeeded in the supplied log for all six supported sports: football 1,032, basketball 131, hockey 170, tennis 369, handball 47 and volleyball 33 (1,782 total). Discovery is complete in that snapshot; H2H collection is separate and continues over subsequent scheduled runs.

Successful evidence is persisted fixture by fixture before the run finishes; a later cancellation does not intentionally clear it. A reader log line by itself is not a Redis write confirmation. The final saved count is authoritative when the worker completes. Matches without readable or comparable H2H data remain unconfirmed, rather than receiving invented support.

After pushing this update, the workflow starts automatically. No Render setting or manual rerun is required. The Node-action deprecation warning and Ubuntu migration notice in the screenshot are separate from the confirmed timeout error.

Validation: parsed the workflow YAML and checked that the job ceiling is 30 minutes, the collection step ceiling is 14 minutes and the worker retains its 690,000 ms budget. No JavaScript behavior changed in this release, and the previous application test suite passed 569 tests.
