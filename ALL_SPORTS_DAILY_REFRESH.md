# All Sports Daily Morning Refresh

The existing `Daily Predictions Refresh` workflow now refreshes all supported sports
from one scheduled workflow at 07:00 WAT every morning.

Parallel jobs:
- Football + Basketball + Ice Hockey via `/api/refresh`
- Handball via the SportyBet Handball network collector
- Volleyball via the SportyBet Volleyball network collector
- Tennis via Tennis Collector V4

GitHub cron:
- 06:00 UTC
- 07:00 WAT (Africa/Lagos)

The individual Handball, Volleyball and Tennis workflows remain available for manual
testing, but the automatic morning schedule is controlled by `refresh.yml`.

Probability models are unchanged:
- Football keeps its independent model.
- Basketball / Ice Hockey / Handball / Volleyball / Tennis keep their existing
  SportyBet no-vig/de-margined market probability approach where applicable.
