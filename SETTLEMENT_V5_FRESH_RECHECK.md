# Settlement V5 — fresh recheck and late-settlement reconciliation

Observed problem:
SportyBet dashboard can already show a winning ticket while Parse.bot `get_booking`
still returns `bookingSettlement: PENDING`.

Fixes:
- Settlement checks call `get_booking` with `fresh: true`.
- A cache-buster is added to avoid stale upstream representations.
- Each pending ticket is retried twice in the same run by default.
- Retry delay defaults to 5 seconds.
- Scheduled reconciliation runs at 01:00, 02:00, 03:00 and 05:00 WAT.
- Previously unresolved recent slips remain eligible for re-check.
- Telegram wording now says "SportyBet settlement still pending" instead of implying
  that the actual matches are still in progress.

Environment options:
TELEGRAM_SETTLEMENT_RETRIES=2
TELEGRAM_SETTLEMENT_RETRY_DELAY_MS=5000
SPORTYBET_SETTLEMENT_TIMEOUT_MS=20000
