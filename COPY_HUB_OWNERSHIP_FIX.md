# Copy Hub Global Booking-Code Ownership Fix

This build prevents the same SportyBet booking code from earning ranking credit for multiple punters.

## Rules

- The earliest **verified public publication** observed for a booking code is marked `original`.
- Later accounts sharing the same booking code are marked `repost`.
- `repost` records are retained for attribution/history but are excluded from win rate, unit ROI, and Copy Score.
- Records without a verifiable public publication timestamp are marked `unknown_origin` and do not receive ranking credit until a verified source is observed.
- If a still-earlier verified publisher is discovered later, ownership is automatically reassigned.
- Existing Redis records are reconciled on read; no Redis wipe is required.
- Settlement checks are deduplicated by booking code, and one settlement result is mirrored to all observed copies.

## Verification

`GET /api/copy/status` now returns:

```json
"globalCodeOwnership": true
```

For the previously observed code `4C6QCU`, the earlier publication timestamp is credited as the original and later publishers are treated as reposts.
