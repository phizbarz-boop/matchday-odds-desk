# Auto Builder Handball + Volleyball eligibility fix

Fixed the "No eligible SportyBet selections..." problem when Handball or Volleyball
were selected while the browser still had old Auto Builder bet-type settings saved
from before those sports existed.

The fix is applied twice:
1. Browser automatically enables compatible markets when the selected sport has none
   in the old saved settings.
2. Backend independently repairs incompatible/stale bet-type requests so an old browser
   cannot create an empty Handball/Volleyball pool.

Volleyball now separates:
- Match Winner
- Total Points Over/Under
- Total Sets Over/Under

The probability model remains no-vig/de-margined SportyBet market probability for
Basketball, Ice Hockey, Handball and Volleyball.

Also fixed Volleyball collector labels and improved API-SPORTS Volleyball alias matching.
