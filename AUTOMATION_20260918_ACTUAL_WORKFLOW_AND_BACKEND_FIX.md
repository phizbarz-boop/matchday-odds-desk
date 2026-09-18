# HISTORICAL CONFIGURATION — SUPERSEDED

The scheduling table below describes a previous revision. The current setup is in `ALL_SPORTS_DAILY_REFRESH.md` and `UNIFIED_REFRESH_0720_WAT.md`: one 07:20 WAT unified six-sport workflow, three manual-only collector workflows, Telegram at 08:25 WAT.

---

# September 18, 2026 — Actual workflow + server timing repair

The ZIP received from the user still had an OLD Telegram cron in the *actual*
`.github/workflows/telegram-picks.yml` (`15 9,18` in America/New_York), even
though an older markdown file claimed it had already been changed. The uploaded
`refresh.yml` also still contained parallel Handball/Volleyball/Tennis jobs,
while their individual workflow files were manual-only. The markdown file was
not evidence that those workflow changes had reached GitHub.

## Actual active schedules to commit to the default branch

| GitHub Actions file | One UTC cron | Nigeria/WAT (UTC+1) |
|---|---|---|
| `.github/workflows/refresh.yml` | `20 6 * * *` | 07:20: Football + Basketball + Ice Hockey |
| `.github/workflows/handball-network-collector-v4.yml` | `5 6 * * *` | 07:05: Handball |
| `.github/workflows/volleyball-network-collector-v1.yml` | `10 6 * * *` | 07:10: Volleyball |
| `.github/workflows/tennis-network-collector-v4.yml` | `15 6 * * *` | 07:15: Tennis |
| `.github/workflows/telegram-picks.yml` | `25 7 * * *` | 08:25: Telegram Auto Picks ONLY ONCE |

None of these workflows has an America/New_York timezone. Each schedule uses an
explicit UTC cron, and each job checks that its triggering schedule is the
expected cron. The three separate collector jobs were removed from the core
refresh workflow. The core workflow now waits for new nonempty persisted
predictions via `jobs/wait-for-predictions.js`; a 200 response that just starts
background processing is not treated as a completed refresh.

## Backend safeguards (must also deploy to Render)

- Automatic `/api/refresh` calls are rejected with HTTP 409 outside
  **07:20–08:15 WAT**. Explicit authorized manual recovery is permitted using
  header `x-matchday-run-mode: manual` (set by `workflow_dispatch`).
- Automatic `/api/telegram/daily-picks` calls are rejected with HTTP 409 outside
  **08:25–09:25 WAT**. This grace period allows a moderately delayed GitHub job,
  but prevents unintended night/evening posts. Manual recovery is possible
  outside this window only if a daily Telegram run has not already started.
- Telegram uses a Redis atomic daily lock (`SET NX`) keyed to the **WAT date**.
  Once posting begins the lock remains even on an error, because a message may
  have been delivered before the request failed. This prevents repeated posts
  from duplicate GitHub runs, other cron services, or a manually rerun workflow.
  A failed attempt *before* any Telegram send is unlocked for recovery.
- `REDIS_URL` **must** be configured on Render. Without shared Redis, the
  Telegram endpoint returns HTTP 503 rather than risk duplicate sends after
  a process restart. This is an intentional fail-closed safeguard.

## To activate the fix

1. Extract the full ZIP, replacing the old project files on **GitHub's default
   branch**, including the entire `.github/workflows` folder. Do not upload the
   ZIP only to Render and expect GitHub Actions schedules to update.
2. Deploy the updated `server.js` and `lib/dailyScheduleGuard.js` to Render.
   Confirm the Render environment has `REDIS_URL`, `REFRESH_SECRET`, and
   `TELEGRAM_JOB_SECRET`, with corresponding GitHub Actions secrets. Do not
   place any secret values in the repository.
3. In GitHub > Actions verify the *real YAML on the default branch* now has
   `30 7 * * *` for Telegram and `20 6 * * *` for Daily Predictions Refresh.
   Verify the independent collector schedules and workflows are enabled.
4. Inspect Render Cron Jobs or other schedulers for OLD tasks that POST to
   `/api/refresh` or `/api/telegram/daily-picks`. Disable redundant tasks.
   We cannot inspect external cron definitions from this ZIP; backend window
   checks now reject incorrectly timed automatic requests regardless.
5. If today's missed refresh requires recovery, manually run the core and sport
   collectors; the manual header bypasses the time window. For Telegram, only
   manually run if nothing has posted already today: the server now skips
   duplicate attempts for the same WAT date.

**Note:** GitHub Actions can start late, or in rare cases drop scheduled jobs;
no cron configuration can guarantee exact-minute delivery. A trigger that
arrives after the Telegram grace window fails instead of sending a late post.

The Copy Hub collection/settlement workflows, betting selection strategies,
probabilities, plans, and removed Telegram settlement checker are unchanged.
