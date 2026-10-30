# Two distinct three-hour tickets

The three-hour batch now has two active variations, A and B, instead of four. Both retain the existing 3-odds target, 70% per-selection probability floor and 6–10 games. There is still no match finish deadline. The schedule remains every three hours WAT.

Previously, only full ticket signatures were excluded, which permitted nearly identical slips sharing most selections. The new planner excludes every chosen match-and-bet-type pair from the second ticket. Different matches may use the same bet type. The same match may appear in both tickets only with different bet types meeting the floor. Exact bookmaker selections also cannot repeat under different internal model labels.

Persistent reservations exclude already-used pairs from later three-hour batches while their matches remain upcoming, including across midnight and restarts. Reservations are acquired atomically before booking; competing manual and scheduled runs cannot book the same pair. Failed or uncertain reservations/bookings are held conservatively rather than blindly retried. Current and previous-day legacy pair records are imported when planning; earlier pre-update records beyond that legacy retention cannot be reconstructed.

Unsent legacy cached plans are rebuilt against these exclusions. Completed or uncertain A/B records are preserved, and retired C/D plans cannot send again. Completed reruns do not fetch a new board. Codes already posted are not deleted from Today's Codes or settlement history.

If a second qualifying variation cannot reach the target with 6–10 distinct matches at the configured floor, it is skipped with the existing explanation rather than copying selections or reducing the floor. This is a constrained model-based ranking, not a guarantee of safety or winning results. No production messages or bookings were sent during development.
