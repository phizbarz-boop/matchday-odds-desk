# Telegram Analyzer — Replace Unsupported Button

The Telegram Analyzer now always analyzes the original SportyBet code first. Unsupported selections are shown as NOT SCORED / unsupported and are not changed automatically.

If at least one unsupported selection is present, the analysis result includes a **♻️ Replace Unsupported** button. Replacement starts only after the user taps that button.

Replacement rules:
- same fixture only;
- cached/saved SportyBet market data only;
- must meet the analyzer minimum-probability threshold;
- must pass red-flag protection;
- ranking preference: probability, quality, edge, then lower odds;
- no forced replacement when a qualifying same-fixture market does not exist.

The replacement action is part of the existing analysis and does not consume another daily analyzer allowance. The booking lookup is protected by the short get_booking cache, while replacement market discovery remains cache-only.
