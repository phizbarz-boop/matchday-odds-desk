# Follow-up cleanup: closing the 1UP / 1H Team Corners removal gaps

The previous pass (`REMOVED_1H_CORNERS_AND_1UP.md`) correctly stopped the Auto
Builder (website + Telegram) from ever fetching 1UP or 1H Home/Away Team
Corners. It missed a few spots that could still cost Parse.bot credits or
show broken UI. This pass closes those.

## Credit-cost fixes (server.js)

- `/api/sportybet/odds` no longer accepts `market=oneup` or
  `market=first_half_team_corners`. Previously the allowlist still included
  both, so the raw endpoint was fully reachable even though nothing in the
  current UI links to it.
- `/api/corners/test-live` and `/api/corners/diagnostics` no longer fetch
  `first_half_team_corners`. They now only look at the regular `corners`
  market, which is still supported.
- `autoCornerDiagnostics()` (used to build the diagnostic message when an
  auto-pick request returns zero selections) no longer fetches
  `first_half_team_corners` either.
- `cornerBetRequested()` no longer references the removed bet-type ids.
- The Telegram AI system prompt's "Bet IDs" list no longer mentions `oneup`,
  `first_half_home_team_corners` or `first_half_away_team_corners`, so the
  natural-language assistant won't suggest markets that no longer exist.

## Stale-browser-settings fix (public/index.html)

Returning visitors whose browser had "1UP" saved as their board filter
(from before the removal) would silently keep re-fetching the 1UP market on
every page load, because `footballSource()` fell back to returning whatever
id it was given when that id was no longer in the market list. Fixed by:

- `footballSource()` now falls back to `'1x2'` instead of echoing back an
  unknown id.
- `loadLocal()` now migrates any saved `oneup` / `first_half_home_team_corners`
  / `first_half_away_team_corners` value in the single-market filter to a
  safe equivalent, and strips those same ids out of saved Auto Builder bet
  type selections instead of carrying them forward.

The Auto Builder route itself was already safe against stale client data
(`needF1hCorners` / `needFOneup` are hardcoded `false` server-side
regardless of what a client sends) — this fix covers the plain single-market
board view, which wasn't guarded the same way.

## Cosmetic fixes

- `lib/telegramAiBot.js`: removed a malformed leftover `['1UP']` entry in
  `ALL_BET_TYPES` that was rendering a Telegram button with an "undefined"
  label for every user. Updated the `/plans` description text, which still
  advertised "1UP" (Pro) and "1H Team Corners" (Elite) as included features.
- `public/index.html`: removed the now-dead `oneup` branches in
  `footballPick()` / `findFootballSporty()`, and removed the per-match stat
  row that used to read "1UP H/A: X% / Y%" but had been stripped down to an
  unlabeled "H/A: X% / Y%" line.

No betting logic, probabilities, thresholds, target odds, red-flag rules,
or subscription tiers were changed.
