# Copy Hub Automatic Settlement 502 Fix

Cause:
The Telegram settlement feature was removed, and the slipTracker import was reduced
to `trackTelegramSlip` only. Copy Hub Automatic Settlement still uses
`evaluateBooking`, so the backend route threw a ReferenceError and returned HTTP 502.

Fix:
- Restored `evaluateBooking` import for Copy Hub.
- Telegram settlement workflow/API remains removed.
- Added an explicit evaluator availability guard for clearer diagnostics.
- Existing Copy Hub per-booking error handling remains unchanged.

No Telegram settlement checking was re-enabled.
