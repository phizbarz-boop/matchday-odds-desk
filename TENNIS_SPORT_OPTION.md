# Tennis sport option

Added Tennis to Plot207.

Website Auto Builder:
- Tennis selectable as a sport.
- Match Winner.
- Total Games Over.
- Total Games Under.
- Uses the same no-vig/de-margined market probability approach as the other non-football sports.

Data:
- New SportyBet Tennis browser/network collector.
- Captures real SportyBet eventId, marketId, outcomeId, specifier and odds.
- Snapshot stored in Redis with memory fallback.

Telegram:
- Tennis appears in sport selection.
- Current subscription rules are preserved:
  - Free remains restricted.
  - Pro remains Football + Basketball + Ice Hockey.
  - Tennis is available through Elite because Elite includes all supported sports.

New GitHub workflow:
- Plot207 Tennis Collector V1

Run the Tennis collector after deployment to discover the exact current SportyBet Tennis markets.
