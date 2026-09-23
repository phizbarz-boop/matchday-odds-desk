# Telegram manual runs: allowed anytime

Updated 2026-09-23.

## Behavior

- Scheduled GitHub Actions runs still use the Redis once-per-WAT-date lock.
- Manual `workflow_dispatch` runs send `x-matchday-run-mode: manual` and bypass the scheduled daily lock.
- A manual run can therefore be started again after the scheduled job or another completed manual job already sent picks that day.
- Manual runs still require the Telegram job secret and preserve cancellation-before-post protection.
- The GitHub concurrency group is retained so overlapping workflow runs are queued instead of posting simultaneously.

## Validation

- `node --check server.js` passed.
- Full Node test suite: 37/37 passed.
