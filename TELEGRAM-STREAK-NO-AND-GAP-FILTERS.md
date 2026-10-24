# Telegram streak No tickets and winner-odds gap options

Automatic Telegram probability batches remain at 07:00 and 18:00 WAT and now have 19 plans. This update includes the previous corners and goal-kick changes.

- Handicaps are excluded from every automatic daily plan, including generic additional markets, Asian handicap, point spread and outcomes identified by an hcp specifier. Exclusion runs during selection and again after current-market validation. Cached unfinished tickets cannot book handicap legs; eligible alternatives are used where available.
- Two additional football plans select only **Any Team To Score 3 or More Goals in a Row — No**: a normal ticket up to 10 games and a long-shot ticket up to 30 games. Both keep the existing 70% per-leg floor and probability-model pipeline. Normal tickets prioritize today and may top up from tomorrow; long shots cover the next seven days. Partial tickets are still sent.
- The streak market uses a dedicated public fixture-feed read requesting the offered streak market plus ordinary 1X2 and totals used by the existing goal-order model. Historical goal rates are used where present; otherwise the existing calibrated model or complete-pair market estimate is used. These are estimates, not guaranteed outcomes. No dummy login is needed for data reads.
- New website Auto Builder and Telegram bot options: **winner odds gap ≤1.00** and **winner odds gap ≤2.00**. The existing **>5.00** option remains. Selecting one switches the others off; all can be off. The gap is the absolute difference between the same fixture's home and away full-match win odds. Draw odds and the odds of the chosen non-winner selection are not used. For example, 1.70 vs 3.20 has gap 1.50, so it passes ≤2 but not ≤1. These optional builder filters do not globally constrain the scheduled Telegram packs.
- Current winner markets are checked before probability modeling. Missing, suspended or mismatched winner prices cannot qualify. All selected probability settings continue to apply. Preferences are saved, and regeneration retains the selected gap option. Conflicting API filter flags are rejected.

Previously booked/posted/uncertain slot checkpoints and Today's Codes are preserved. Existing completed scheduled slots are not reopened; use a new manual GitHub workflow run to test the release after deployment. All active daily long-shot plans remain capped at 30; the overall booking platform cap stays 50.

Validation: all 494 non-browser tests passed. Coverage includes gap boundaries, mutually exclusive controls, the website API with different qualifying fixture counts, preserving probability floors, streak-market modeling and exact booking IDs, dedicated plan contents, and removing handicaps from cached unfinished plans. No real bookings or Telegram messages were sent during verification.

No new environment variables are required. Deploy the ZIP contents through the connected repository, then reload the website.
