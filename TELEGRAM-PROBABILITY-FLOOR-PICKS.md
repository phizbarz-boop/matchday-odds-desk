# Twice-daily probability tickets

07:00 and 18:00 Africa/Lagos (WAT): six tickets, no fixed combined odds target. All-sports floors: 90%, 80%, 70%. Tennis-only, basketball-only and ice-hockey-only: 75%. At most 20 selections and one selection per match per ticket. Rank eligible selections by the existing model probability; never lower floors to fill a ticket.

Market families belong to one ticket in each batch. They may repeat on different matches within that ticket. Matches may appear in different tickets with different bet types. The evening excludes all morning match-and-bet-type pairs, including very high probability picks. Persistent Redis reservations survive restarts. Unknown booking/send outcomes are held rather than duplicated. Empty plans report no qualifying selections. Today's Codes persists every confirmed new code and shows code and odds only.

Scan all sports and additional supported public SportyBet markets without dummy login. Unsupported or unmodelable market partitions remain excluded; offered-price estimates retain the existing model basis. Fresh validation must confirm offered selections and floors before booking.

Only upcoming prematch fixtures in the current WAT date are considered. Scheduled end times are preferred; when absent, conservative duration allowances are football/handball 3h, basketball/hockey/volleyball 4h, tennis 4h (6h for known best-of-five matches). Estimated completion must be before midnight WAT. Real finish times are not guaranteed.

The app scheduler is primary, with a 2h catch-up window. GitHub's new probability workflow is a backup at 06:00 and 17:00 UTC; Redis slot deduplication prevents two copies. Manual workflow requests run only the current due slot. Existing Telegram token/chat/secret and working Redis configuration are required. Render sleeping and GitHub scheduling delays can delay delivery. Set TELEGRAM_FLOOR_PICKS_ENABLED=false to disable the app scheduler; disable the workflow as well to stop all triggers.

Old hourly, QC, three-hourly, SAFE and target-odds next12h endpoints remain retired. Manual builders, public refresh and results reporting are unchanged.
