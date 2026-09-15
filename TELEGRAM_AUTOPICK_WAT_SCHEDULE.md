# Telegram Auto Pick WAT Schedule

The automatic Telegram picks now run twice daily on Nigeria/WAT time:

- 08:00 WAT
- 19:00 WAT

GitHub Actions uses UTC:
- 07:00 UTC = 08:00 WAT
- 18:00 UTC = 19:00 WAT

The morning run is deliberately one hour after the 07:00 WAT Daily Predictions
Refresh so Football, Basketball, Ice Hockey, Handball, Volleyball and Tennis have
time to refresh before Telegram builds the tickets.

Manual `workflow_dispatch` remains available.
