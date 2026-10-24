# Football daily picks with winner-odds gap at most 1

The 07:00 and 18:00 WAT probability batches now have 23 plans.

New plans:
- Football Under 4.5 goals: normal up to 10 games, long shot up to 30.
- Football Corners Under 12.5: dedicated normal up to 10 games, long shot up to 30. These are additional to the earlier combined Under 11.5/12.5 plans.

Both new pairs require a home-versus-away winner-odds gap of 1.00 or less. The existing Any Team To Score 3 or More Goals in a Row — No normal/long-shot plans now require that same gap. All six plans retain the 70% per-selection model floor. Normal plans prioritize today and may top up from tomorrow; long shots cover seven days. Partial tickets still send when fewer games qualify. Automatic tickets continue to exclude handicaps, and generated codes go into Today's Codes.

The gap compares the full-match home and away winner prices for the same event, ignoring the draw price. It is measured from raw offered prices, independently of the probability of the selected goals/corners/streak outcome. It does not require either team's win probability to meet 70%. Current winner prices are read during pack creation and checked again through fresh public market validation before booking. Missing, suspended, mismatched or widened winner prices fail the gap check; saved eligibility flags are overwritten.

Website and bot:
- Replace the former winner-odds gap ≤2.00 option with a strictly **above 8.00** option.
- Keep the ≤1.00 and >5.00 options, with one filter selectable at a time.
- A gap of exactly 8.00 does not pass >8.00.
- Old ≤2 preferences are not silently reinterpreted as >8. Old regeneration requests with that retired setting are reset; legacy API requests that explicitly enable it receive a clear error.

Previously completed and uncertain booking checkpoints remain protected against duplicate sends. Unfinished cached plans receive the updated plan rules, and fresh validation enforces them. Completed scheduled slots are not reopened. Start a new manual workflow run after deployment to test the updated batch.

Validation: 498 non-browser tests passed, including website API filtering, strict >8 and inclusive ≤1 boundaries, current-price eligibility refresh before booking, dedicated plan market identity and limits, saved controls, probability floors and handicap exclusion. No real Telegram messages or bookings were made during verification. No new environment variables are required.
