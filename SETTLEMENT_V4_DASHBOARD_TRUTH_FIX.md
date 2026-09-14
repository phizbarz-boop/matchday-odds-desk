# Settlement V4 — SportyBet dashboard truth fix

This fixes a false-loss case where SportyBet shows a ticket as WON but Plot207
reports it as lost/pending.

Changes:
- Reads bookingSettlement when it is a string OR nested object.
- Reads nested wrappers such as data, booking, betSlip, payload and result.
- Overall booking settlement is authoritative.
- If overall booking settlement resolves to WON, Plot207 marks the ticket BOOMED
  even if an individual leg is stale, UNKNOWN or incorrectly classified.
- If overall booking settlement resolves to LOST, Plot207 marks it lost.
- Leg-level settlement is only used when there is no usable overall booking result.
