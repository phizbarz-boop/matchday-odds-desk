# Telegram Daily Auto Picks — Same Day Only

The scheduled/manual `/api/telegram/daily-picks` job now only uses fixtures whose kickoff date is **today in Africa/Lagos (WAT)**.

Rules:
- Today's date is calculated in `Africa/Lagos`.
- Candidate kickoff is converted to the same timezone before comparison.
- Tomorrow/later fixtures are rejected.
- Fixtures with missing or invalid kickoff timestamps are rejected.
- Red-flag and probability filters run after the same-day filter.
- Website Auto Builder and manual Telegram Builder settings are unchanged.

The Telegram daily summary now reports the WAT date, how many non-today candidates were rejected, and how many same-day candidates remained.
