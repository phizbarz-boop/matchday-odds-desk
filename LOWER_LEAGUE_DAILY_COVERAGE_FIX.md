# Lower-league Daily Coverage Fix

This update is deliberately isolated from SportyBet booking-code creation.

## What changed
- Daily API-Football enrichment default ceiling increased from 180 to 500 matched SportyBet fixtures.
- SportyBet fixture dates are processed in chronological order.
- Team-name normalization now recognizes common `Utd`/`United` and `St`/`Saint` variants.
- If API-Football has a fixture but `/predictions` does not provide a usable goal estimate, Matchday builds a conservative Poisson goal model from each team's recent completed results.
- Recent-result fallback profiles are cached in memory during the Daily Refresh so the same team is not requested repeatedly.
- Website/Telegram Analyzer can score imported Football Over 0.5, Over 1.5 and Under 4.5 directly from `predictions:latest` instead of buying SportyBet market pages again.
- The Analyzer preserves the imported SportyBet event/market/outcome identifiers.

## Booking code safety
No `book_bet`, `get_booking`, booking payload, booking route, or booking scraper settings were changed.

## Optional settings
- `API_FOOTBALL_MAX_FIXTURES=500`
- `API_FOOTBALL_GOAL_FALLBACK_LAST_MATCHES=6`
- `API_FOOTBALL_GOAL_FALLBACK_MAX_TEAMS=240`

The fallback uses API-Football only; it does not spend additional Parse.bot credits.
