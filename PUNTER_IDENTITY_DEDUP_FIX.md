# Punter identity deduplication fix

This build migrates legacy Copy Hub punter IDs automatically.

## Why duplicate rows appeared
Older Copy Hub builds keyed X punters from `x:<username>`. A later build used `x:name:<username>`. Existing Redis records therefore could contain two internal IDs for the same X account, which rendered as duplicate leaderboard rows.

## Current behavior
- X uses the stable X `author_id` (`sourceUserId`) whenever available.
- SportySocial uses the stable SportyBet `userId` whenever available.
- Legacy IDs are reconciled on every Copy Hub store read and on every write.
- Entries and code-owner references are remapped to the canonical punter ID.
- Name-only legacy records are merged into a UID-backed record when the source + normalized username match.
- Existing Redis data does not need to be deleted.

The migration is backward compatible and does not alter booking-code ownership or settlement logic.
