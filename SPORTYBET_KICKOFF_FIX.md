# SportyBet kickoff filtering fix

Diagnostics proved that the upstream SportyBet endpoint is returning many valid market rows but most rows do not include `kickoffUtc`.

Example from Render:
- football/1x2 raw=102
- validKickoff=0
- invalidKickoff=102
- upcoming=0

The old stale filter treated "missing kickoff" as "stale", which discarded every one of those rows.

This build fixes that:
- rows with a valid kickoff in the past are still removed;
- rows with a valid future kickoff are kept;
- rows where SportyBet omits kickoff are ALSO kept instead of being discarded;
- kickoff parsing recognizes additional common upstream field names;
- cache namespace bumped to v9;
- speed protections (in-flight request de-duplication and 60-second empty cache) remain enabled.

Render logs now show:
`[SportyBet filter] raw=... validKickoff=... missingKickoffKept=... pastOrStartedRemoved=... returned=...`
