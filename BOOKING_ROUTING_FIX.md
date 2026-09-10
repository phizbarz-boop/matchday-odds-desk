# Booking routing fix

This restores the pre-corners booking behavior for normal selections.

- Normal markets (Home Win, Draw, Away, O/U, DC, DNB, GG/NG, AH, etc.)
  are booked through the SportyBet Nigeria Parse endpoint first, using the exact
  JSON-string `selections` body format that was previously working.

- Special markets (Corners, 1H Corners, 1UP) are booked through the full-market
  endpoint first because those IDs are discovered there.

- Both paths retain one fallback to the other endpoint.

The server detects special markets from the full slip metadata that the browser
already sends as `telegramContext`; no secrets are sent to the browser.
