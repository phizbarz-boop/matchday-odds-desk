# Telegram high-odds closest-ticket policy

1000x and 10000x try today's games first and progressively roll through the next seven WAT dates. Match winners are attempted first; eligible supported alternative markets are considered if needed. The existing 80% per-leg floor, one selection per fixture, 40-selection limit, future kickoff and red-flag protections remain.

Unlike the prior strict-cache-only edition, candidate loading now prefers saved prediction/market snapshots and caches but may fetch missing or stale SportyBet market pages. It does not explicitly trigger the Daily Predictions Refresh endpoint. Upstream calls may use Parse.bot credits.

If there are no qualifying selections for a target, report NOT GENERATED. If eligible selections exist, a valid 1000x/10000x ticket is sent even below target; its message says CLOSEST AVAILABLE and displays its real combined odds. If construction, validation or booking-code generation fails, report that distinct failure instead of pretending a ticket was published.

SAFE/10x/20x/50x/100x rules and Free Today's Codes access (SAFE and 10x, including games) remain unchanged. Telegram settlement checking remains removed.
