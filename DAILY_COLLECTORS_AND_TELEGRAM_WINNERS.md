# Daily collectors and winner-only Telegram auto picks

All times Africa/Lagos (WAT, UTC+1), using UTC GitHub cron:

- 07:00 WAT: Daily Predictions Refresh (Football / Basketball / Ice Hockey).
- 07:05 WAT: separate Handball Collector V4 workflow.
- 07:10 WAT: separate Volleyball Collector V1 workflow.
- 07:15 WAT: separate Tennis Collector V4 workflow.
- 08:00 WAT and 19:00 WAT: Telegram Auto Picks workflow.

Collectors remain independently runnable via workflow_dispatch. Their duplicate jobs were
removed from `refresh.yml` to avoid simultaneous duplicates and needless resource usage.
A GitHub schedule is best-effort and may start late; check Actions logs if a job does
not trigger or if no fixtures are published. The three collector workflows need
SPORTYSOCIAL_LOGIN_ID, SPORTYSOCIAL_PASSWORD and TELEGRAM_JOB_SECRET configured.

Telegram automated daily slips (not the interactive AI Builder or Website Auto Builder):
- ONLY full-match winner markets: Football home/away win, Basketball/Ice Hockey/
  Handball/Volleyball/Tennis match winner. No draw, totals, handicaps, BTTS or corners.
- 10x, 20x, 1000x and 10000x: at least 80% probability for EVERY leg.
- SAFE 1.30–5.00x: unchanged at 90% for EVERY leg, now match winners only.
- Same-day WAT fixtures and existing red-flag protection remain.
- If a qualifying slip cannot be formed, report NOT GENERATED rather than lowering
  minimum probability or introducing other market types. Very high odds may be
  unattainable under the probability and max-selection constraints.
- Non-football probabilities are no-vig sportsbook market estimates, not proven outcomes.
