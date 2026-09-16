# Telegram Auto Picks: cached rollover and Free Today's Codes

This update is based on the supplied 50x/100x winner-first project.

## Source and 7-day rollover
- Automatic Telegram picks prefer existing predictions/snapshots and market caches, but missing or stale market data can be fetched. `marketCacheOnly:false` allows upstream market requests; the job does not explicitly trigger Daily Predictions Refresh.
- SAFE, 10x, 20x, 50x and 100x remain today-only and match-winner-only.
- 1000x and 10000x try today first. If the target isn't reached, they add eligible fixtures from tomorrow through seven days ahead, in WAT date order. They try match winners first; other supported markets are used only when the winners cannot reach the target. 10000x considers all six supported sports regardless of the configured Telegram sport scope.
- Eligible fixtures must have a valid future kickoff, pass red-flag filtering and the existing 80% per-selection threshold (SAFE 90%). One outcome per event, at most 40 selections.
- Rollover uses real eligible fixtures (cache first, fresh markets where required). A shorter available fixture window provides only its real dates. When a high-odds target is not met, it can publish the closest valid selection set with actual odds shown; NOT GENERATED is reserved for no qualifying selections.
- Booking-code creation remains an external SportyBet request after a valid ticket is assembled. Market fetching may also generate upstream requests.

## Free Today's Codes
- Free users can read SAFE and 10x booking codes AND their individual selections (sport, teams, pick, odds, kickoff WAT date and estimated selection probability).
- Other tickets remain locked in this view for Free users. Pro/Elite can see available daily codes and games.
- The bot persists sanitized selections alongside newly generated booking codes. Previously saved records that lack selections show an honest 'game details unavailable' message; they are not re-fetched.
- Long Today’s Codes responses are split into Telegram-sized messages.

## Scope
- Does not re-enable the removed Telegram settlement checker. The separate Copy Hub settlement checker is untouched.
- Existing refresh workflow schedules, subscription pricing, manual and interactive builders remain unchanged.
