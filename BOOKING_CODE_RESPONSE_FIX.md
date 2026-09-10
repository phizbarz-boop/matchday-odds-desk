# Booking code final compatibility fix

The full-market SportyBet Parse wrapper and the SportyBet Nigeria wrapper use different contracts.

Full-market:
- accepts selections as a JSON array in the documented contract
- returns `booking_code` and `share_url`

Nigeria wrapper:
- documents `selections` as a JSON-encoded string
- returns `shareCode` and `shareURL`

The app now:
1. tries full-market with a real array,
2. tries full-market with a JSON string for compatibility,
3. falls back to the Nigeria wrapper,
4. normalizes snake_case and camelCase response fields,
5. exposes safe booking failure diagnostics in the UI.
