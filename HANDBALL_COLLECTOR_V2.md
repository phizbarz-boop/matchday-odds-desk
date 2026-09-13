# Handball Collector V2

Run GitHub Actions -> **Plot207 Handball Network Collector V2** -> **Run workflow**.

This test:
- reuses `SPORTYSOCIAL_LOGIN_ID`
- reuses `SPORTYSOCIAL_PASSWORD`
- logs into SportyBet
- opens Handball
- captures `/api/ng/factsCenter/wapConfigurableEventsByOrder`
- attempts to extract eventId, gameId, teams, kickoff, tournament and markets
- uploads diagnostics as `sportybet-handball-v2`

It does not place bets and does not change Telegram or Auto Builder behavior.
