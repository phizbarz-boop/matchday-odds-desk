# H2H fixture links and identity verification

The supplied artifact h2h-panel-debug-40308157927.zip contains three failed fixtures:

- sr:match:72732582: SportyBet returned HTTP 400 for a descriptive URL containing Wilkes-Barre%2FScranton_Penguins.
- sr:match:74117344: SportyBet returned HTTP 400 for a URL containing HK_Zemgale%2FLlu.
- sr:match:72175952: the reader rejected team identity, although the later diagnostic capture shows Vaasan Sport U20 and JYP in the match header and a populated H2H panel. The artifact does not record the expected names or the earlier verification snapshot, so the exact mismatch cannot be established from it.

Descriptive path slugs now replace slash and backslash separators with underscores before URL encoding. The immutable SportyBet event ID is retained. Fixture identity must still match after the page loads.

Identity checking now normalizes presentation whitespace and underscores, waits up to 2.5 seconds for a temporarily rerendering header, and checks the current fixture header rather than searching historical opponents or future fixtures. It retains team words and youth qualifiers; it does not use fuzzy team aliases. If identity remains unverified, diagnostics include the expected public team names and captured header. The cache still requires exact fixture identity and event ID.

The existing full Chromium/Xvfb worker configuration remains in place. The supplied artifact confirms its statistics loader received HTTP 200 JavaScript for the identity-failure example. Failed advertising requests in that report are not evidence that H2H loading failed.

After pushing, start a NEW H2H History Worker run with event_id blank to continue the queue. Manual runs bypass recent failure cooldowns. To test individually, use sr:match:72732582 or sr:match:74117344 while still upcoming and queued. Success requires saved > 0. These URL changes and retry behavior are tested locally; the two live HTTP 400 cases require a new GitHub run for confirmation.

Keep SPORTYBET_H2H_ENABLED=false on Render. Website and Telegram continue using shared cached H2H evidence. This update does not change probability floors, ticket schedules, booking, sport discovery or the treatment of matches without comparable H2H evidence.
