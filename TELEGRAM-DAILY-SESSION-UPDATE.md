Telegram catalogue update

Daily 07:00 / 18:00 WAT: football, basketball, handball and volleyball long shots, up to 20 games; any-team three-goal streak NO normal/long; Under 4.5 normal; new 1UP home/away long shot; Double Chance & Under 4.5 and Home/Away & Under 4.5 each target 3 odds, maximum six games. All use the existing probability model, minimum 70%.

Removed daily Over 0.5/1.5, corners, shots on target, all-sports winners, tennis/hockey long shots. All long shots exclude totals/over-under and all automated tickets exclude handicaps. 1UP is a selected home/away team market, not an invented either-team outcome; draws are excluded. Only actual offered selections are booked.

Three-hour frequency remains two unique 3-odds variations, six to ten legs, 70% floor.

Today’s Codes is a display filter using each code’s saved generation timestamp: morning window starts 06:00 WAT (includes the 06:00 batch before 07:00 daily picks), evening starts 18:00 WAT. Evening hides the morning list. All newly generated codes in the window accumulate. Archive and settlement history are not deleted. Legacy codes without per-code timestamps are hidden rather than assigned an invented time. No extra production Redis keys or polling required.

No live messages or booking requests were submitted during testing.

Performance update: removes ten-winning-leg display cutoff; lists all legs on each reviewed ticket including losing/pending slips and older newly updated tickets. Existing official settlement and void/half-result return rules are preserved. New tracked selections save their generation-time model probability; missing historical estimates remain unknown. Adds cumulative bet-type, probability-band and ticket-type win/loss breakdowns. Exact repeated selections are deduplicated in market statistics. Recommendations require at least 20 decisive unique results per market, explain sample sizes, and do not equate hit rate with profit or claim a causal floor effect. Telegram's existing message chunking delivers the full report.

Combo correction: Double Chance & Under 4.5 and Home/Away & Under 4.5 use a 60% per-selection floor, target 3 odds, maximum six games. Other plans keep 70%. Existing internal plan IDs are retained to preserve booking/delivery checkpoints.
