# Plot207 Sports — Separate automatic daily prediction workflows

The six sports now run as six independent GitHub Actions workflows. A failure or delay in one sport no longer prevents the other sports from starting.

| Sport | Workflow file | Daily UTC | Nigeria/WAT |
|---|---|---:|---:|
| Football | `.github/workflows/refresh.yml` | 06:05 | 07:05 |
| Basketball | `.github/workflows/basketball-daily-predictions.yml` | 06:10 | 07:10 |
| Ice Hockey | `.github/workflows/ice-hockey-daily-predictions.yml` | 06:15 | 07:15 |
| Handball | `.github/workflows/handball-network-collector-v4.yml` | 06:20 | 07:20 |
| Volleyball | `.github/workflows/volleyball-network-collector-v1.yml` | 06:25 | 07:25 |
| Tennis | `.github/workflows/tennis-network-collector-v4.yml` | 06:30 | 07:30 |

Telegram Auto Picks remain separate at 07:25 UTC / 08:25 WAT, after the sport prediction workflows have started.

## What changed

- Football now has its own workflow only; the old combined six-sport jobs were removed from `refresh.yml`.
- Basketball has its own daily workflow.
- Ice Hockey has its own daily workflow.
- Handball, Volleyball and Tennis collector workflows now each have their own daily cron instead of being manual-only recovery workflows.
- Every sport workflow still supports `workflow_dispatch`, so it can be run manually from GitHub Actions if needed.
- Basketball and Ice Hockey use a protected `POST /api/refresh/sport/:sport` endpoint. It force-refreshes the SportyBet winner + totals snapshots instead of reusing yesterday's daily snapshot.
- Their probability model remains the existing no-vig/de-margined SportyBet market model. Football keeps its existing Poisson + H2H model. Handball, Volleyball and Tennis keep their existing collector/model logic.

## Required secrets

GitHub Actions:
- `REFRESH_SECRET`
- `SPORTYSOCIAL_LOGIN_ID`
- `SPORTYSOCIAL_PASSWORD`
- `TELEGRAM_JOB_SECRET`

Render/server:
- the matching `REFRESH_SECRET`
- `PARSE_API_KEY`
- `REDIS_URL`
- the existing sport/API secrets already used by your project

## Activation

Commit/deploy the whole project, including the hidden `.github/workflows` folder and the updated `server.js`. The Basketball and Ice Hockey workflows require the updated server endpoint, so deploy Render before relying on their scheduled runs.
