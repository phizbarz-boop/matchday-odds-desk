# Analysis job recovery

Previously, background analysis jobs and their completed results lived only in one Node process. A deploy/restart lost the job, and another process could not answer the polling request.

This update connects analysis job storage to the existing server getRedis adapter (REDIS_URL). When Redis is available, the job record is persisted before acknowledging the submission, completed results are retained for 30 minutes, and another process can retrieve them. A separate short worker lease lets another process distinguish a running job from an interrupted scan. Temporary storage errors return a storage-specific error, not a false missing-job result. When no Redis is configured, the existing local-only mode remains available, with no claim of restart persistence.

The browser restarts a missing or interrupted analysis once, using the same settings, only for /api/sportybet/auto-pick and /api/sportybet/analyze-code. Both perform analysis without submitting a booking. It never restarts a booking endpoint, an arbitrary failed request, a timed-out scan, or a Telegram job. Active work is not resumed midway after a crash; a new read-only scan is started. A second interruption is returned to the user. Polling/recovery remains subject to the existing five-minute browser deadline.

Completed/failed job storage expires automatically. Local completed jobs can be evicted to admit another analysis; a Redis-backed result can still be read through its original ID. This does not prevent host restarts or fix their underlying causes.

Validation: focused tests cover cross-instance result retrieval, remote pending jobs, interrupted worker leases, refusal to acknowledge storage failures, one-time client recovery, and no booking retries. The complete non-browser suite passes 533 tests. No live analysis or booking request, deployment, or Telegram send was performed.

Deploy the complete ZIP as usual. Keep the working REDIS_URL configuration. The package also includes the preceding Chromium/H2H installation fix and ticket labels.
