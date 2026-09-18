# Football team Over 0.5 and Pro pricing (September 2026)

- Added **Home Over 0.5 Goals** and **Away Over 0.5 Goals** for the website's football tabs and Auto Builder, Telegram Auto Picks, Telegram interactive AI builder (Pro/Elite) and the analyzer.
- Full-match **Under 4.5 Goals** was already available and remains available in website, Auto Builder, and Telegram; it has not been replaced by team Under 4.5.
- New model rates are computed separately for the two teams from Poisson scoring and capped H2H, or from API-Football per-team goal lambdas. An old cached prediction lacking team-specific estimates cannot be used for these new markets; rerun the daily refresh to populate them.
- Requires a real bookmaker **Home Total / Away Total** FULL MATCH market with exact `total=0.5` and Over outcome. Uses returned event, market, outcome IDs and specifier only. If the selected market does not exist or no price is offered, the selection is omitted; no guessed market identifiers. Availability on the user's Parse.bot subscription has not been verified live.
- Pro subscription is **₦5,000/month**, matching the existing buttons and admin payment messaging. Other plan limits, extra ticket prices and Elite price are unchanged.
- GitHub Actions schedules and Telegram posting guard remain unchanged.
