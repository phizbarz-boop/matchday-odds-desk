# Website Booking Analyzer optimization/fix

This build addresses the generic `Could not analyze this booking code` failure by reducing
upstream SportyBet/Parse load and making failures visible.

Changes:
- Analyzer determines booking sport before loading any extra market.
- Basketball/Hockey analysis no longer warms the football Over 1.5 market.
- Football Over 1.5 repair is loaded only when a generic O/U leg actually needs it.
- Analyzer infers relevant bet types from the booking and requests only those market families.
- `loadAutoCandidates()` now honors requested bet types at FETCH time instead of fetching
  every market and filtering only afterward.
- Added Analyzer timing logs in Render.
- Production frontend now displays a safe reason such as timeout or upstream HTTP error.
- All existing fixture, Telegram AI, shared-pool, Copy Rankings, and subscription fixes remain.
