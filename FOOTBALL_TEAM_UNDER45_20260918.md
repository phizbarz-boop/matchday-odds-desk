# Football Home/Away Under 4.5 — update

Added two **separate full-match team-goal bets** across the website, Auto Builder, automatic Telegram picks, Telegram AI plan selections and analyzer:

- `home_under45`: **Home Under 4.5 Goals** — the home team scores 0, 1, 2, 3 or 4 goals.
- `away_under45`: **Away Under 4.5 Goals** — the away team scores 0, 1, 2, 3 or 4 goals.

These do **not** mean full-match Under 4.5 (combined goals). The existing `under45` full-match market remains separate and unchanged.

The Poisson/H2H model and API-Football enrichment calculate separate per-team probabilities, saved as `homeU45` and `awayU45`. The corresponding SportyBet market must be a genuine **full-time team-total** market for the correct home/away side with the exact `total=4.5` line and Under outcome. We do not guess market identifiers; actual SportyBet market, outcome and specifier IDs are preserved. No substitute full-match bet is generated when the team-total market or prediction is unavailable.

**Deployment:** Replace the repository files and deploy to Render, then run a new prediction refresh to populate the new team-specific probabilities. New bets become available only if the bookmaker feed exposes the matching exact markets. Pro remains ₦5,000. The scheduled workflows remain unchanged (07:20 WAT six-sport refresh; 08:25 WAT Telegram).

Local tests cover per-team probability calculations, market validation, candidate construction, Telegram parsing, existing subscription price and all prior tests. Live bookmaker availability and production deployment are not verified.
