# Telegram Auto Picks: Mixed markets with sport priority (18 September 2026)

This change applies **only to the scheduled Telegram Auto Pick targets 10x, 20x, 1000x and 10000x**. It leaves the independent SAFE strategy, the website Auto Builder, and the interactive Telegram AI Builder unchanged.

- Attempt **Ice Hockey + Basketball first**, using any supported, probability-qualified market (including match winners, Over and Under).
- If that combined pool cannot reach the requested target, expand in order: **Handball**, **Volleyball**, **Tennis**, then **Football**. The first pool able to reach a target is used; football is last.
- All six sports are available to each of the four Auto Pick targets regardless of the older `TELEGRAM_SPORT_SCOPE` setting.
- Per-selection minimum model probabilities: **10x and 20x: 80%; 1000x and 10000x: 70%**.
- Maximum legs: **10x and 20x: 30; 1000x and 10000x: 40**. Environment maximum can lower, but cannot increase these ceilings.
- Other supported markets include sport-specific Over/Under, handball totals, volleyball totals/sets, tennis totals/handicaps, and supported football markets, including full-time corners. Previously removed 1UP and first-half team corners are still excluded.
- Existing same-day fixture filter and red-flag filtering remain active. High targets retain the **CLOSEST AVAILABLE** booking behavior if a selection exists but target odds cannot be attained. A ticket is not guaranteed to win.
- The SAFE 1.30–5.00x target still has a 90% floor and its existing Ice Hockey + Basketball mixed-market preference.
- Workflow schedule remains **one Telegram Auto Pick at 08:30 WAT daily** (`30 7 * * *` UTC); no schedule changes.
- Optional `TELEGRAM_MIXED_PICK_TRIALS` overrides the mixed-market optimizer trial count; if unset, the existing `TELEGRAM_PICK_TRIALS` variable is honored, otherwise 500 per candidate tier is used to bound total work.

## Deploy

Replace the attached project's files in GitHub and deploy updated `server.js` and `lib/telegramMixedSelector.js` to Render. The new module is required; deploying just `server.js` will fail. There is no need to change GitHub workflow schedules.
