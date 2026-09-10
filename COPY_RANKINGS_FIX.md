# Copy Rankings Fix

The ranking UI was treating pending, unsettled codes as ranked results. That produced rows with 0.0 score / 0.0% win rate and Telegram also read the wrong username property, so every account appeared as “Punter”.

This build fixes both:
- only punters with at least one settled tracked code appear in the actual leaderboard;
- pending tracked codes are counted and shown as pending, not ranked;
- Telegram now reads the real nested punter username and shows @handles;
- when nothing has settled yet, Telegram and website explain how many codes are tracked/pending instead of showing fake 0.0 rankings;
- existing automatic settlement workflow remains unchanged.
