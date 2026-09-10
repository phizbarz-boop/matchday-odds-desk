# Website Analyzer – Replace Unsupported

This update mirrors the Telegram Analyzer replacement flow on the website.

- The first analysis is shown unchanged.
- If one or more legs are unsupported / NOT SCORED, a `♻️ Replace Unsupported` button appears.
- Nothing is replaced automatically.
- Only unsupported legs are considered. Supported legs below the user's probability threshold are left unchanged.
- Replacements must be from the exact same fixture, meet the selected minimum probability, and pass red-flag protection.
- Replacement market lookup is cache-only; it does not trigger fresh Parse.bot market scans.
- The website shows the original selection and the new replacement before a new SportyBet code is generated.
- The existing booking-code creation and `get_booking` integration were not modified.
