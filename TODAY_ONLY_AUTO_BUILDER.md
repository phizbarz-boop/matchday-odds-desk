# Today Only Auto Builder

Adds an optional **Today Only (WAT)** fixture filter to both the Website Auto Builder and Telegram Auto Builder.

- OFF (default): existing behavior; any upcoming eligible fixture may be used.
- ON: only selections with a valid kickoff whose Africa/Lagos calendar date is today are eligible.
- Fixtures with missing/invalid kickoff are excluded when Today Only is ON.
- The filter is applied after candidate loading, so it reuses the existing cache and does not require a separate Parse.bot fetch.
- Booking creation, booking lookup, prediction scoring, red-flag rules, and Parse IDs are unchanged.
