# Persistent prediction cache merge

This update changes only the prediction-cache write path.

- Daily refresh reads the previous `predictions:latest` snapshot before replacing it.
- A previously scored future SportyBet fixture is retained if it temporarily disappears from the next refresh.
- If the same future fixture is refreshed as an API-Football fixture-only / zero-probability row, the last known-good model is retained.
- Newly refreshed good models always take priority.
- Fixtures that have already kicked off are not carried forward.
- Old zero-probability rows are not carried forward.
- Cache merge failure is non-fatal: a normal fresh snapshot is still written.
- SportyBet booking creation and `get_booking` code are unchanged.
