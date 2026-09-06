# SportyBet Auto Refresh Fix

This build fixes the `SportyBet football: 0 outcomes loaded` stale-empty-cache problem.

Changes:
- Cache version bumped from v5 to v6, so old Redis market caches are bypassed after deploy.
- Empty SportyBet responses are no longer cached for the normal 12-hour TTL.
- If a cached market becomes empty after expired/kicked-off fixtures are removed, it is deleted and SportyBet is fetched immediately.
- A successful non-empty response is still cached normally to control Parse/SportyBet usage.
- Existing stale-fixture kickoff filtering remains enabled.

Result: newly-added fixtures can be discovered on the next request instead of an old zero/stale cache blocking them.
