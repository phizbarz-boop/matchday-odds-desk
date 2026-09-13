# Handball V4 — Plot207 integration

Handball now uses the exact same probability approach as Basketball and Ice Hockey:

- SportyBet prices are grouped by market/line.
- The bookmaker margin is removed (no-vig/de-margined probability).
- This market probability is used for Winner and Total Goals candidates.
- Red-flag protection, minimum probability, maximum odds and normal Auto Builder selection rules still apply.
- API-SPORTS Handball is used only to match/validate fixture identity and coverage. It does NOT replace the no-vig probability model.

Flow:
1. GitHub Handball V4 logs into SportyBet.
2. V4 captures complete fixtures + markets.
3. V4 publishes the snapshot to `/api/internal/handball/snapshot`.
4. Plot207 stores it in Redis (memory fallback).
5. API-SPORTS matching is attempted using the existing API key.
6. Website/Auto Builder can use Handball Winner + Total Goals using the same no-vig engine as Basketball/Hockey.
7. Booking still uses the real SportyBet event/market/outcome/specifier IDs captured by V4.

Required existing secret:
- TELEGRAM_JOB_SECRET (GitHub + Render)

API-SPORTS key:
- API_SPORTS_KEY, or the existing API_FOOTBALL_KEY / API_FOOTBALL_API_KEY.
