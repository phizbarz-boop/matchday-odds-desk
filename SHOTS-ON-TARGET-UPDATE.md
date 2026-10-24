# Shots on target website and Telegram picks

Website changes:
- Remove the Throw-ins / Highest available Under checkbox and clear it from saved website selections. Imported selections remain analyzable.
- Add three distinct football choices in the match list and Auto Builder: Shots on Target Under 13.5, Shots on Target Under 12.5, Shots on Target Over 4.5.
- The same three new markets are available in the bot builder. They are full-match combined team totals, not player, team-only, first-half or total-shots markets.

New daily Telegram plans at 07:00 and 18:00 WAT:
- Combined Under 13.5 / Under 12.5: one normal ticket up to 10 games and one long-shot ticket up to 20. Both require a full-match home/away winner-odds gap ≤1.00.
- Over 4.5: one normal ticket up to 10 games and one long-shot ticket up to 20. Both require a full-match home/away winner-odds gap strictly >8.00.

The new plans retain the existing 70% minimum model probability. Only the four new shots-on-target plans use 20-game long-shot caps; other daily long-shot caps remain 30. There are now 27 daily plans in total. Normal tickets prioritize today and may top up from tomorrow; long shots cover seven days. Partial tickets still send when fewer eligible games are offered. Handicaps stay excluded from automatic picks. Codes continue to be saved in Today's Codes.

Public SportyBet full-match Shots on Target Over/Under market 900393 was verified directly. Data collection uses its public fixture feed and includes ordinary winner prices for gap checks. It does not require a dummy login or depend on per-event detail probing. The three dedicated IDs preserve original bookmaker outcome IDs and line specifiers. An unavailable 4.5, 12.5 or 13.5 line is not replaced with another line.

Probabilities use the existing complete-outcome, margin-adjusted market estimator. There is no newly invented independent shots-statistics model or promise of accuracy. Incomplete price pairs are not scored. Current winner prices are checked again during booking validation; missing or changed gap eligibility cannot reuse a saved qualifying flag. Shots on target cannot be settled from the football goal score and require official bookmaker/stat settlement.

Validation: all 504 non-browser tests passed. Tests cover exact market/line identification, separate website choices, public feed collection, gap boundaries, floors, 10/20-game limits, one match per ticket, and preventing goal-score settlement. A read-only public feed sample returned all three requested lines; the sample was partial and is not a count of the entire current board. No real bookings or Telegram messages were sent during verification.

No new environment variables are required. Deploy the ZIP contents via the connected repository, refresh the website and start a new manual workflow run to test. Existing completed or uncertain job checkpoints are preserved; already processed scheduled slots are not reopened.
