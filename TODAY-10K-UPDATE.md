## Daily Telegram picks

- Retired 1UP, Double Chance & Under 4.5 at 3 odds, Volleyball long shot, and Any Team 3+ Goals in a Row — No long shot. Home or Away & Under 4.5 and the short 3-goal-streak ticket remain.
- Ice Hockey Highest Under 6.5–8.5 remains a 20-game maximum with no minimum probability.
- The 07:00 and 18:00 WAT batches attempt three distinct tickets, up to 30 fixtures, prioritizing combined odds of at least 10,000 and no minimum probability. Only unstarted fixtures kicking off on the current WAT date and scheduled or estimated to finish before the end of the following WAT day qualify. The search compares model probabilities and prices, gives higher-probability early starters a stronger preference and favors different selections across variations. It is a bounded search, not a proven optimum. Different tickets can share selections. Correct-score markets are excluded, individual odds are capped at 2.00, and the ranking penalizes odds far from the roughly 1.36 average needed across 30 legs for 10,000. These checks also apply at fresh validation before booking.
- Each variation is rechecked before booking. If 10,000 is unavailable, a slip strictly above 1,000 can be sent as a labeled fallback. A slip can have fewer than 30 fixtures, including after the fresh check. If no slip clears 1,000, no code is booked. Telegram shows the available booking code and a kickoff-ordered selection list. The new codes remain visible in Today's Picks until WAT midnight, including manual test codes.
- Earlier kickoffs do not guarantee earlier settlement or an offer. SportyBet limits Cashout to selected markets and may withdraw it.

## Manual test

After deploying the updated server, open GitHub **Actions → Test Today 10,000+ Picks → Run workflow**. It uses the existing `TELEGRAM_JOB_SECRET` and `MATCHDAY_BASE_URL` configuration. It generates and posts the new variations only; it does not place wagers or trigger the rest of the daily batch.

The manual test builds from the published catalogue and still validates selections against fresh SportyBet data. It stops polling after three consecutive transient status failures; check Telegram and server logs before retrying an unconfirmed run.
