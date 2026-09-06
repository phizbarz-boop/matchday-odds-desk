# Website / Telegram shared candidate pool fix

The website could build Basketball while Telegram reported zero with looser settings.
This build removes the duplicated eligibility logic.

Both Website Auto Builder and Telegram AI now call the exact same
`prepareAutoCandidatePool()` function for:
- sport scope
- minimum probability
- minimum edge
- exact bet types
- red-flag protection
- max odd per match

Telegram also logs and reports candidate counts when zero results occur:
raw -> after red flags -> after max-odd filter.

Basketball and Hockey saved market IDs are normalized to the canonical three
sport-specific IDs so old user state cannot silently poison a build.
