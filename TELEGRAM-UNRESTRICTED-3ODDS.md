# Three-odds variations without a match finish deadline

This revision supersedes the finish-window rules in TELEGRAM-THREE-HOUR-REVISION.md.

Removed these automated daily short tickets: tennis 10 games; combined Corners Under 11.5/12.5 10 games; Shots on Target Over 4.5 10 games; combined Shots on Target Under 13.5/12.5 10 games. Their remaining long-shot versions still cap at 20 games. No website or interactive bot market is removed.

Four distinct 3-odds variations still run every three hours WAT, using the current 70% per-selection floor and 6–10 matches per ticket. The model ranks candidate combinations by estimated winning probability using the existing bounded search. Qualifying matches no longer need to finish within three hours or have a known finish timestamp. Upcoming prematch tennis can qualify without an estimated end. The collector now scans the ordinary seven-day upcoming feed horizon rather than restricting fixture discovery to three hours; no finish-time rule is applied to returned candidates.

The three-hour interval is only the posting schedule. Live, started, invalid-kickoff, below-floor, handicap, and previously removed goal-kick selections remain excluded. Matches and bet types may overlap between variations but the four full ticket combinations must be distinct. A variation is skipped if its target or minimum count cannot be reached at the configured floor.

Old cached packs have their obsolete finish-window settings cleared when active configuration is applied. Completed/uncertain booking and delivery checkpoints are preserved to prevent duplicates. Removed plan IDs cannot send from an old pack. Today's Codes and settlement tracking remain active. No actual Telegram messages or bookings were made during development.
