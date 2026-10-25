# SportyBet scan memory fix

The supplied Render log reports a V8 JavaScript heap exhaustion near 250 MB. It does not establish one sole source of the allocation. This update addresses retention and duplication found in the data-loading paths:

- Request-local completed responses use a 24 MiB estimated-retention budget and 96-entry limit. Old completed responses can be read again if needed. Pending reads still share the same in-flight work; unrelated user requests never reuse completed request-local prices.
- Process response and market/snapshot caches use 16 MiB estimated-retention budgets with 64-entry limits. The team-goal bundle cache has an 8 MiB budget. Expired entries are removed when accessed or replaced. Oversized responses remain usable by their caller without being retained in these caches.
- Concurrent background catalogue reads share one Redis/disk read and parsed object. Subsequent reads refresh from storage after five seconds. Market indexes reuse that catalogue object rather than rebuilding every sport's index for each market request.
- Public refresh drops raw fixture list market trees before collecting event details, retaining normalized rows and fixture identities. Available market types, pagination coverage, suspended-market replacement, probability floors, schedules and booking validation are preserved.

These cache budgets are conservative estimates, not a hard cap on the whole process. Active responses, normalized candidate pools, JSON serialization and Chromium require additional memory. Production peak memory must be checked after deployment; this is not a claim that any feed size fits every Render instance.

Validation: unit/integration tests cover read sharing, updates observed after the short read window, eviction/expiry, public collection coverage and request isolation. A synthetic scan of 240 distinct 2,500-row responses completes in a child Node process with a 64 MB maximum old-space heap. This is a retention regression test, not a replay of production SportyBet traffic. No live bookings or Telegram messages were sent.

Deploy the complete ZIP using the supplied command, preserving .env files and data. The package includes the basketball period totals and non-blocking missing-H2H behavior from the preceding release. No additional environment variable is required for this fix.
