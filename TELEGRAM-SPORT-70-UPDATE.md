Telegram ticket update

Schedule: 07:00 and 18:00 Africa/Lagos (WAT). Three-hourly hockey picks stay removed.

13 ticket plans, all using the existing probability model and minimum full-win probability 70%:
- Football, tennis, basketball, ice hockey, handball and volleyball each receive one ticket of up to 10 games and one long-shot ticket of up to 50 games.
- One all-sports winner-only ticket of up to 30 games. Only this plan requires the home/away winner odds difference to be strictly above 5.00; it is rechecked before booking.
- Sport-specific tickets consider all available supported modelled bet types without the odds-gap filter.

Short and all-sports tickets prefer qualifying same-day games, then tomorrow's qualifying games. Existing estimated/explicit same-day finish checks apply within each date. Long shots accept upcoming fixtures within seven days, ranked by odds among selections passing 70%, then probability. One selection per match within each ticket; bet types may repeat across matches/tickets. If a selection fails fresh validation, eligible backups are tried. If fewer games remain than the target count, the smaller ticket is booked and sent. No notice replaces a ticket merely because it is incomplete. Zero qualifying selections still produce a notice; no picks are invented and the floor is never lowered.

50-selection ceiling is applied consistently to website display, supported Telegram generators, analyzer-generated tickets and booking request validation. Bot subscription-specific selection limits remain in effect (Elite supports 50).

Manual GitHub workflow runs are tests, available at any time. Each workflow run/attempt uses a separate batch ID, can repeat previously used games, and does not alter scheduled daily reservations. Repeated HTTP submissions or polls for the same test ID reuse that test's saved result. Manual messages are marked MANUAL TEST. Tests do not wait for the scheduled GitHub concurrency group. Existing network/provider latency still applies; no instant-delivery guarantee.

Scheduled runs remain idempotent per WAT slot; evening avoids morning event/market-family pairs. Codes and settlement tracking are preserved, including Today’s Codes. Ambiguous booking/delivery outcomes are held rather than automatically duplicated.

Deployment required. No real booking or Telegram send was performed during verification.
