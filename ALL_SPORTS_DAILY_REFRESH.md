# Daily refresh setup (current)

All times Nigeria (WAT = UTC+1). GitHub Actions runs schedules on the default branch.

- 07:00 WAT — `refresh.yml`: Football, Basketball and Ice Hockey. The action
  POSTs `/api/refresh` then verifies that `/api/predictions.generatedAt` has
  moved forward before marking the job successful. The API starts the refresh
  in the background, so an HTTP 200 alone does not indicate completion.
- 07:05 WAT — `handball-network-collector-v4.yml`: independent daily Handball job.
- 07:10 WAT — `volleyball-network-collector-v1.yml`: independent daily Volleyball job.
- 07:15 WAT — `tennis-network-collector-v4.yml`: independent daily Tennis job.
- 08:30 WAT — `telegram-picks.yml`: ONE scheduled Telegram Auto Pick run.

The individual collectors are not duplicated in the core refresh. They
require the SportySocial credentials and `TELEGRAM_JOB_SECRET` in GitHub
Actions Secrets to publish their snapshots. Their logs show the publication
result, or fail with a clear error. Football/Basketball/Hockey refresh needs
`REFRESH_SECRET`. Telegram Auto Pick needs `TELEGRAM_JOB_SECRET`.

GitHub schedules are best effort, NOT an exactly-once execution guarantee.
Check that Actions is enabled and these workflow files are on the repository's
DEFAULT BRANCH. To catch up after a missed schedule, run the workflows manually
in time order. Do not manually rerun Telegram if it already posted today,
since this version does not have a persistent exactly-once send lock.
`REDIS_URL` on Render is recommended to persist predictions across restarts.
