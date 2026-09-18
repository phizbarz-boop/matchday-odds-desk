# Plot207 – football team-goal market discovery (September 18, 2026)

The previous implementation asked `get_prematch_football_markets` for Home/Away
Total rows and fell back to the **separate SportyBet.com** scraper's
`get_upcoming_events` / `get_event_odds` endpoints. The Nigeria common-market
endpoint is not guaranteed to include team goals, and the second scraper is
not guaranteed to be in the account's subscription. A passing mock test did
not prove that a live market was available.

This revision uses the **Nigeria scraper's** documented
`get_football_event_markets?event_id=...` endpoint to look up complete event
odds for actual fixture IDs already saved in `predictions:latest`. The four
markets share each event request, preserving the bookmaker's real event,
market, outcome, and line identifiers. A separate cache version prevents old
empty lookup results from blocking the corrected path. The website and Auto
Builder/Telegram use the same saved fixture IDs.

Markets are only accepted if they exactly match the full-match home/away side,
the 0.5/4.5 line, and the Over/Under direction. We do **not** relabel match
totals, corners or first-half markets as team totals and do not fabricate a
booking selection when SportyBet does not offer the requested line.

If a bet type still has zero selections, the website's market status or Auto
Builder response now distinguishes a missing saved fixture/model, a bookmaker
line absent in the scanned events, and an upstream subscription/error issue.
Run the normal prediction refresh after deployment if `modeledFixtures` is
zero. Check the browser error's `status`, row count and `modeledFixtures` before
assuming the remaining zero result is a parser bug.

**Cost safeguard:** `SPORTYBET_TEAM_GOAL_MAX_EVENTS` defaults to 12 events per
market bundle (one full event request per fixture, *not* four per fixture).
Each successful Nigeria `get_football_event_markets` call is advertised at
3 credits. Therefore the first uncached full scan of 12 fixtures could use
up to approximately 36 credits. The API responses are reused from memory for
12 hours per event; market bundles are shared across all four bet types and
briefly cached for 5 minutes. You can lower `SPORTYBET_TEAM_GOAL_MAX_EVENTS`
(for example 4) to reduce cost or raise it (up to 30) to widen the scan.
Selecting an unsupported line will still return no selection.

No live Parse.bot account was available to test here. Unit tests mock the
published flat `data.outcomes` response and verify that only genuine returned
IDs and correct markets are accepted. Do not interpret those tests as proof
that any particular real fixture offers the lines today.
