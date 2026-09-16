# Telegram per-target selection ceilings

- 10x / 20x: up to 25 selections each.
- 50x / 100x: up to 30 selections each.
- 1000x / 10000x: up to 40 selections each.
- SAFE: unchanged; global TELEGRAM_MAX_SELECTIONS applies.

The app's existing Telegram booking guard is 40 selections. A requested
50-selection ticket therefore is not enabled here without verified upstream
support; the high-target ceilings use 40 instead. These are **maximums**,
not minimums: the builder may stop earlier when it reaches its target.
TELEGRAM_MAX_SELECTIONS may lower any plan ceiling.

No changes to probability filters, market priorities, scheduled jobs, or the
independent interactive Telegram AI plan limits.
