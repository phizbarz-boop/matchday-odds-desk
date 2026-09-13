# Tennis V2

Based on the first successful collector run:

- 140 SportyBet Tennis fixtures were discovered.
- Winner market is confirmed as market 186.
- Set Handicap is confirmed as market 188.
- Total Games rows were also captured.
- Tennis uses SportyBet no-vig/de-margined probability; there is no API-SPORTS
  validation matcher in this build, so the misleading 0/140 API-SPORTS status was removed.
- Collector scan budget increased from 30 to 45 to improve metadata coverage
  beyond the previous 130/140 virtualized page rows.
- Tennis Set Handicap Home/Away is now available to the Auto Builder.
- Real SportyBet IDs/specifiers are preserved for booking.

After deployment run:
Plot207 Tennis Collector V2
