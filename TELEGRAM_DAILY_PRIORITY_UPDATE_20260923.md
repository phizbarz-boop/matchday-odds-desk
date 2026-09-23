# Telegram Daily Auto Pick Priority Update — 2026-09-23

## Scheduled 1.30 SAFE ticket
- Build target starts at 1.30 (SAFE output still validates inside 1.30–5.00).
- Maximum 15 selections.
- Primary sports: Ice Hockey + Basketball.
- If needed: Tennis, then Handball + Volleyball.
- Football is not used by this scheduled priority selector.
- Match Winner selections are attempted before any other supported market.

## Scheduled 2x and 3x tickets
- Maximum 20 selections each.
- Primary sports: Ice Hockey + Basketball + Tennis.
- If the primary pool cannot complete the target: add Handball + Volleyball.
- Football is not used by the scheduled 2x/3x selector.
- Match Winner selections are attempted first across the permitted priority sports.
- Other supported markets are used only if winner-only pools cannot reach the requested target under the selection cap.

## Unchanged
- Minimum probability remains 90% per selected leg.
- Existing red-flag protection remains enabled.
- SportyBet booking-code generation and daily scheduling remain unchanged.
- Website Auto Builder and interactive Telegram AI Builder are not changed by this update.

## Validation
- `node --test tests/*.test.js`: 36/36 passed.
