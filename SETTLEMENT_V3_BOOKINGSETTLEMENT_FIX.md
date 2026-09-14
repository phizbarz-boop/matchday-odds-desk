# Settlement V3 — bookingSettlement fix

Problem fixed:
- Parse.bot `get_booking` returns an overall `bookingSettlement`.
- The old tracker did not include `bookingSettlement` in its recognized status fields.
- A SportyBet ticket could therefore be WON while Plot207 still reported pending/unknown.

New behavior:
1. Overall `bookingSettlement` is the first source of truth for the ticket.
2. Per-selection `settlement` / `selectionSettlement` is also recognized.
3. If the booking says WON, the ticket is marked BOOMED even when non-football legs
   individually return UNKNOWN.
4. The 01:00 WAT job checks the just-ended WAT matchday plus unresolved tracked slips
   from the previous 3 days by default.
5. Previously pending winners can therefore be corrected on a later settlement run.
6. Ticket reports include the raw bookingSettlement for diagnosis.

Environment:
TELEGRAM_SETTLEMENT_LOOKBACK_DAYS=3 (default, configurable 2–14 days)
