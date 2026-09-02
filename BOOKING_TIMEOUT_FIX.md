# Booking timeout fix

Symptoms:
- Generate SportyBet Code stays on "Generating..." indefinitely.

Fix:
- Browser aborts the booking request after 18 seconds.
- Parse.bot booking requests are capped at 12 seconds by default.
- A timed-out primary booking route does not trigger another long fallback wait.
- Normal markets still use the Nigeria booking route first.
- Corners/1UP use the full-market booking route first.

Optional Render env:
SPORTYBET_BOOKING_TIMEOUT_MS=12000
