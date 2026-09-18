# Football team total runtime discovery fix

Home/Away Over 0.5 and Home/Away Under 4.5 now use the normal SportyBet football-market endpoint first. If that endpoint returns zero rows, the loader falls back to the subscribed full-event odds path (`get_upcoming_events` / cached `get_event_odds`) and filters the actual full-time side-specific team total line.

This fixes `raw 0 · safe 0` errors caused by the managed football-market endpoint not exposing Home Total / Away Total rows. Full-event responses are cached by event ID, but fallback use can still consume Parse.bot credits when not already cached.
