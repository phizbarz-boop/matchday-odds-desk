# SportyBet Speed + Refresh Fix

The previous zero-cache fix was too aggressive: every request for an empty market could immediately call Parse/SportyBet again. That made individual market/game loading slow and multiplied upstream traffic.

This build:
- adds a 60-second negative cache for empty markets (`SPORTYBET_EMPTY_CACHE_SECONDS`, default 60);
- deduplicates simultaneous requests for the exact same sport/market/window, so one upstream call is shared;
- keeps normal non-empty caching;
- keeps the 15-minute Auto Builder freshness ceiling;
- keeps stale kickoff filtering;
- bumps the cache namespace to v7.

This balances fast page loading with discovery of newly-added fixtures.
