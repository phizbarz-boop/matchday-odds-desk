# AI / Hockey / Market Consistency Fix

Root causes found from the screenshots:

1. Telegram's Elite hockey market IDs were malformed:
   - stored as `HK Winner`, `HK Over`, `HK Under`
   - engine expects `hockey_winner`, `hockey_over`, `hockey_under`
   This could leave Telegram with zero hockey candidates while the website had hundreds.

2. Natural-language ticket parsing used an `else if` chain, so a request like
   `corners and over 0.5, 1.5` kept only the first recognized market.
   It now collects every market mentioned.

3. A new sport request could inherit incompatible bet types from the previous ticket.
   Example: a previous football corners request followed by `20 odds hockey match`.
   Telegram now selects compatible hockey markets when the user changes sport without
   explicitly naming a market.

4. Changing sport from the Telegram Builder button now repairs incompatible saved markets.

5. Website Auto Builder now applies the same server-side red-flag filter used by Telegram.

6. Existing Redis users are migrated from the three legacy hockey labels to the correct IDs.
