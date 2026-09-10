# Parse.bot credit-usage optimization

No user-facing settings or betting rules were changed.

The Parse dashboard showed `get_event_odds` as the main drain:
1,497 calls / 2,994 credits.

This build fixes the multiplication at the source:

- `get_event_odds` caches the COMPLETE event payload by event ID for 12 hours.
- Corners, First-Half Team Corners and 1UP reuse that same full event payload.
- Concurrent requests for the same event share one in-flight Parse request.
- `get_upcoming_events` pages are shared for 15 minutes across the three special markets.
- Duplicate event IDs are removed before the expensive fallback loop.
- Failed/402 responses are never cached.
- Booking calls (`get_booking` / `book_bet`) are not cached or altered.
- Ordinary prematch market freshness behavior remains unchanged.
- Website settings, Telegram settings, probabilities, target odds, max games,
  red flags, subscriptions, and market selections are unchanged.

Render now prints `[Parse Usage]` lines showing upstream vs cacheHit vs shared calls.
