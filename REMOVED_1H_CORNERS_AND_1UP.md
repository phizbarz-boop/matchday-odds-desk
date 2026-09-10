# Removed markets

Per owner request, these markets are removed from both Website and Telegram AI:
- 1UP
- 1H Home Team Corners O/U
- 1H Away Team Corners O/U

What changed:
- Removed from Website bet-type controls.
- Removed from Telegram bet-type menus and plan-allowed markets.
- Natural-language AI requests no longer select these markets.
- Auto Builder no longer fetches their SportyBet market feeds.
- Candidate generation no longer creates them.
- Analyzer no longer treats them as supported target markets.
- Existing user settings for other markets are unchanged.
- Regular full-match Corners Over/Under remain supported.
- All other probabilities, thresholds, target odds, max games, red flags,
  subscription tiers, and API settings are unchanged.

This should further reduce Parse.bot usage, especially expensive get_event_odds fallback calls.
