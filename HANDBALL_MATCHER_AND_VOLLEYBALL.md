# Plot207 — Improved Handball Matching + Volleyball

## Handball matcher upgrade
The API-SPORTS Handball matching layer now:
- normalizes accents and punctuation
- removes common Handball club prefixes/suffixes
- handles common spelling/transliteration differences
- uses token similarity + character similarity
- searches API-SPORTS on the SportyBet date plus/minus one day
- tolerates a reversed home/away orientation at a penalty
- keeps team names and kickoff time as the dominant match signals

This improves validation coverage but does not change the probability model.

## Volleyball
Volleyball is now available as a Plot207 sport option.

Flow:
SportyBet Volleyball collector
→ complete SportyBet fixture/market IDs
→ API-SPORTS Volleyball fixture matching/validation
→ Redis snapshot
→ no-vig/de-margined probability
→ Auto Builder
→ existing SportyBet booking pipeline

Probability model:
Volleyball uses the SAME no-vig market probability model as Basketball, Ice Hockey and Handball.

Initial enabled markets:
- Match Winner
- Total Points Over
- Total Points Under

A new GitHub Action is included:
**Plot207 Volleyball Collector V1**

It uses the same existing GitHub secrets:
- SPORTYSOCIAL_LOGIN_ID
- SPORTYSOCIAL_PASSWORD
- TELEGRAM_JOB_SECRET
