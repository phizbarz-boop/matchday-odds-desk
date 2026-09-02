# SportyBet booking-code fix for special markets

Corners, 1H team corners and 1UP are loaded from the subscribed full-market SportyBet scraper.
Those selections can use event/market/outcome IDs that are not valid in the older NG scraper.

This build creates the booking code against `PARSE_BOOKING_SCRAPER_ID` first, i.e. the same
full-market scraper that supplied those IDs. If that endpoint rejects a standard-market slip,
the app falls back to `PARSE_SCRAPER_ID`.

No API keys or tokens are exposed to the browser.
