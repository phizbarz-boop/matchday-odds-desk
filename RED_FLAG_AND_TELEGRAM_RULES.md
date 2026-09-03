# Red Flag + Telegram rules

## Website Auto Builder
The probability threshold remains user-adjustable.
A red-flag sanity filter is always applied before auto-selection:
- reject edge > +25 percentage points
- reject model probability >=90% with odds >=1.70
- reject model probability >=85% with odds >=2.00
- reject model probability >=80% with odds >=2.50

## Telegram
Four sets per daily run:
- 50x: every leg probability >=70% (no quality threshold)
- 20x: same
- 10x: same
- SAFE: every leg probability >=80% (no quality threshold), combined odds 1.30-1.35

No target is forced. If no qualifying combination reaches the target/range, that set is skipped.
The same red-flag filter applies to Telegram. Positive edge is NOT required.


Quality score is displayed for information but is not used as a Telegram eligibility filter.
