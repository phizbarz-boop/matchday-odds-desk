# Hourly Quick Cash and live selection rules

## Scheduled Quick Cash

The new `telegram-quick-cash.yml` GitHub Actions workflow requests `/api/telegram/quick-cash` every hour at :05 WAT. It reads current SportyBet live markets, applies a **0% minimum probability**, builds a fresh booking/share code, and sends the ticket to the configured Telegram chat. It creates no monetary wager.

The hourly QC ticket uses a flexible 2.00 combined-odds target and up to 15 unique fixtures by default. It sends the available qualifying combination even when that target is not reached. Optional server settings:

- `TELEGRAM_QC_TARGET_ODDS`: combined-odds target; default `2`.
- `TELEGRAM_QC_MAX_SELECTIONS`: maximum selections; default `15`, capped at SportyBet's 40-selection limit.

The existing `TELEGRAM_JOB_SECRET` GitHub secret and server setting authenticate the job. The configured Telegram bot/chat, dummy SportyBet booking session and shared `REDIS_URL` are also used. No new required secrets or paid data key are introduced.

After pushing and redeploying, the hourly workflow is available under **Actions → Plot207 Telegram Hourly Quick Cash**. **Run workflow** can test the current hour. Scheduled and manual requests share the hourly duplicate-send guard. GitHub Actions can delay scheduled starts; the ticket reads current data when the job actually runs.

## Today’s Codes

Every successfully generated QC code is stored with its WAT hour in a separate Redis hash and merged into the Telegram bot's **Today’s Codes** list. Daily reruns cannot erase QC history. QC codes are visible on Free, Pro and Elite, with the newest QC hour first. Existing daily codes retain their plan rules.

If no eligible games remain, the job records a skip without sending an empty ticket. It tries current games again next hour. If a failure or workflow cancellation occurs before Telegram posting, the hourly lock is released for retry. Once posting begins, the lock is kept because delivery may be ambiguous.

## Website and interactive Telegram live rules

All live selections, including the live portion of a mixed prematch/live ticket, must satisfy both:

1. The match is still ongoing and has reached at least halfway through regulation play or the supported set format.
2. The actual offered selection is currently winning against its score, total or handicap line.

Football uses 45 minutes or halftime/second-half evidence; basketball uses halftime/Q3 or later; ice hockey uses 30 minutes or the final period/overtime; handball uses 30 minutes or halftime/second-half evidence. Set sports require at least half their maximum sets completed. A best-of-three/five format can come from an explicit format field or the offered full-match correct-score outcomes. If the format cannot be proved, the longer best-of-five boundary is used conservatively. Point scores are not treated as completed sets.

QC adds its late-stage rule: football 75+ minutes in regulation, basketball Q4/overtime, ice hockey final period/overtime, handball 50+ minutes in the second half, or a provable deciding set in tennis/volleyball.

Winner markets follow the current leader; draw/double-chance selections follow their exact outcome; DNB and handicap pushes do not count as wins. Handicaps use the offered home/away line, rather than merely checking the leading team. Totals compare current goals, points, games or played sets with the line; an under is currently qualifying only while its current total remains below that line. Such a selection can still lose later. Corners require actual corner counts. Missing score/progress/line data, incomplete set scores and unsupported period/combined markets exclude a selection.

The selected user probability settings remain active on interactive website and Telegram builds. Only the scheduled hourly QC ticket fixes its minimum at 0%. No probability threshold overrides the halfway, currently-winning, availability or red-flag checks.

All live selections are checked against a second current SportyBet read immediately before code generation. Suspended/settled markets, inactive outcomes, ended matches, changed leaders and uncovered handicap lines are dropped.

## Validation

161 Node tests passed, including HTTP flows through the real server with mocked upstream services. Checks cover hourly deduplication, cancellation/retry, no-game skips, 0% scheduled probability, booking generation, Telegram posting, Today’s Codes visibility/history, early-match exclusion, score changes before booking, handicap orientation, totals, match formats from offered score markets and missing set/corner data. These tests do not send real Telegram messages or create real SportyBet bookings.
