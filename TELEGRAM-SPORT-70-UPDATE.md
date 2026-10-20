Telegram morning/evening picks

Schedule stays 07:00 and 18:00 Africa/Lagos (WAT).
The previous six morning/evening plans are replaced by 13 plans:
- Football, tennis, basketball, ice hockey, handball, volleyball: one 10-match ticket and one 40-match long-shot ticket each.
- One 30-match all-sports winner-only ticket, requiring home/away winner odds difference strictly above 5.00.
All selections require model full-win probability >=70%. Public SportyBet feeds supply offered markets and fresh selections; booking uses the existing booking integration.
Sport-specific tickets have no odds-gap filter. Short tickets rank by model probability; long shots rank by odds among qualifying selections, then model probability. Every ticket contains one selection per match. Market types may repeat on different matches or tickets. The evening batch continues excluding the morning's exact event/market-family pairs. Games must meet the existing same-day start/finish checks.
SportyBet supports at most 40 selections, so the requested 50-game tickets are capped at 40. Incomplete tickets are skipped with the available count; floors and counts are never silently reduced. Available supported/modelled markets are considered, including expanded markets. This does not add unmodelled markets or guarantee wins.
Booking validation rechecks probabilities and winner-gap eligibility; existing uncertain-booking and delivery checkpoints remain in place. Codes are saved in Today's Codes.
The separate three-hourly ice-hockey automation is removed: no app timer or GitHub workflow; its authenticated endpoint returns 410 without scanning, booking, or sending.

Validation: 438 non-browser tests passed across the full run plus the corrected status expectation rerun. Browser login was unchanged and excluded. No real tickets were booked or Telegram messages sent during testing. Deployment still required.
