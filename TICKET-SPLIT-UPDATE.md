Ticket splitting

Website: use My SportyBet Slip or analyze an imported code, choose Split into 1–10 tickets, then Preview split. The preview shows matches, original combined odds and model probability ranges. Generate/resume creates one separate SportyBet booking code per group. Fifty selections split into five tickets produces ten selections in each. Uneven counts are distributed as evenly as possible, retaining all selections.

Telegram bot: after analyzing a booking code, tap Split Original Ticket and choose 1–10 parts. Each resulting code consumes one ticket credit; required credits are checked before generation. Membership sport and per-ticket limits apply. The original ticket is reanalysed without replacements or probability filtering. Model probabilities determine ranking, highest first; unscored selections remain at the end. No matches or bet selections are substituted, duplicated, or deliberately removed. Missing exact IDs/odds or repaired selections must be resolved by analyzing the original code first.

Odds are the original per-selection odds used to calculate each group's displayed original combined odds. A five-part split does not preserve the full 50-game total odds on each individual ticket; the product of the five group totals equals the original total, before bookmaker price changes. SportyBet prices can change at booking, and sharing codes cannot freeze them. Partial/uncertain bookmaker confirmations stop further generation rather than silently dropping an original selection.

Website split progress and confirmed codes survive a page refresh in the same browser tab through session storage. Bot split progress and codes persist for two days in Redis. Repeating the same completed split retrieves stored codes; uncertain parts are not submitted again automatically. Each Telegram account can process one split at a time.

No real bookings or Telegram sends were made during validation. Deployment required.
