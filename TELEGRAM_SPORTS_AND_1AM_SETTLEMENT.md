# Telegram Sports + 01:00 WAT Matchday Settlement

## Telegram Builder sport selection
The sport keyboard now shows:
- Football
- Basketball
- Ice Hockey
- Handball
- Volleyball
- Tennis
- Select All

Select All selects every sport unlocked by the user's subscription plan.
It does not bypass plan restrictions.

Saved Telegram preferences now retain Handball, Volleyball and Tennis instead of
dropping them during user normalization.

## Daily settlement
GitHub Actions runs `Matchday Daily Slip Settlement Check` at:
- 00:00 UTC
- 01:00 WAT (Africa/Lagos)

At 01:00 WAT it checks Auto Pick slips generated on the WAT matchday that just ended.

For every ticket it reports:
- ticket target and SportyBet code
- total selections
- explicit won legs
- explicit lost legs
- void/push legs
- pending legs
- unknown legs
- BOOMED / full ticket won
- ticket lost
- not fully settled

A ticket is marked BOOMED only when SportyBet/booking settlement data confirms the
ticket is won (or every returned leg is won/push). Unknown non-football leg settlement
is not guessed as a loss.

The summary also reports the total daily leg wins/losses/pushes/pending/unknown and
how many of SAFE, 10x, 20x, 1000x and 10000x tickets BOOMED.
