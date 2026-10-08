# Hourly Quick Cash and live selection rules

> Historical instructions for the earlier hourly batch. For the current Live 3, QC 3 at an 80% minimum, and Live 1,000 picks, see [TELEGRAM_HOURLY_MODEL_PICKS.md](TELEGRAM_HOURLY_MODEL_PICKS.md).

> Current update: hourly Telegram QC/live generation and its workflow are removed. Website live/QC, SAFE, next-12-hours picks and result reports remain. This earlier guide records the previous hourly implementation. See [SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md](SPORTYBET_PUBLIC_READS_BOOKING_ONLY.md).

Manual GitHub daily picks run SAFE plus the five hourly categories immediately,
and new manual runs can repeat in the same hour. See
[TELEGRAM_MANUAL_ALL_PICKS.md](TELEGRAM_MANUAL_ALL_PICKS.md).

## Scheduled Quick Cash and reporting

Current schedules, ticket categories, installation and result calculations are documented in [TELEGRAM_HOURLY_SPORT_QC_AND_ROI.md](TELEGRAM_HOURLY_SPORT_QC_AND_ROI.md).

The app server's direct hourly job at :05 WAT creates separate QC Ice Hockey,
QC Basketball, QC Handball + Volleyball and QC Football tickets at 0%, plus
Live All Sports at 85%. GitHub's hourly workflow is now manual-only. See
[TELEGRAM_DIRECT_HOURLY.md](TELEGRAM_DIRECT_HOURLY.md) for activation and uptime
requirements. The old scheduled 2x/3x/1000 sport templates are removed. The
morning SAFE remains at 08:25 WAT. Every hourly code is added to Today’s Codes
under its category and hour.

At 00:10 and 12:10 WAT, a result report identifies winners, closest/worst fully resolved losing tickets and hypothetical ₦100-per-sent-ticket ROI, with unresolved stakes shown separately.

## Website and interactive Telegram live rules

All live selections, including the live portion of a mixed prematch/live ticket, must satisfy both:

1. The match is still ongoing and has reached at least halfway through regulation play or the supported set format.
2. The actual offered selection is currently winning against its score, total or handicap line.

Football uses 45 minutes or halftime/second-half evidence; basketball uses halftime/Q3 or later; ice hockey uses 30 minutes or the final period/overtime; handball uses 30 minutes or halftime/second-half evidence. Set sports require at least half their maximum sets completed. A best-of-three/five format can come from an explicit format field or the offered full-match correct-score outcomes. If the format cannot be proved, the longer best-of-five boundary is used conservatively. Point scores are not treated as completed sets.

QC adds its late-stage rule: football 75+ minutes in regulation, basketball Q4/overtime, ice hockey final period/overtime, handball 50+ minutes in the second half, or a provable deciding set in tennis/volleyball.

Winner markets follow the current leader; draw/double-chance selections follow their exact outcome; DNB and handicap pushes do not count as wins. Handicaps use the offered home/away line, rather than merely checking the leading team. Totals compare current goals, points, games or played sets with the line; an under is currently qualifying only while its current total remains below that line. Such a selection can still lose later. Corners require actual corner counts. Missing score/progress/line data, incomplete set scores and unsupported period/combined markets exclude a selection.

The selected user probability settings remain active on interactive website and Telegram builds. The four scheduled hourly QC tickets fix their minimum at 0%; scheduled Live All Sports uses 85%. No probability threshold overrides the halfway, currently-winning, availability or red-flag checks.

All live selections are checked against a second current SportyBet read immediately before code generation. Suspended/settled markets, inactive outcomes, ended matches, changed leaders and uncovered handicap lines are dropped.

## Validation

258 Node tests pass, including HTTP flows through the real server with mocked
upstream services and direct server scheduling. See the current hourly/report
document for coverage and deployment verification. Real Telegram delivery and
authenticated SportyBet booking creation have not been exercised here.
