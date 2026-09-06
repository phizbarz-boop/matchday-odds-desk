# Copy Hub Historical False-Code Cleanup

This build automatically quarantines historical X/Telegram/manual records that do not look like plausible SportyBet booking codes.

Examples quarantined automatically include ordinary words such as `PLEASE`, `READY`, `HERE`, and `FROM`, plus patterns such as `CORNER50`.

Quarantined records:
- are marked `status: invalid` if they were pending;
- are excluded from Copy Hub rankings;
- are excluded from automatic settlement;
- cannot consume Parse.bot settlement checks;
- remain in storage only as audit history.

SportySocial share codes are trusted because they are supplied directly by SportyBet's authenticated Code Hub feed, including rare letter-only codes.

The settlement API response now includes `quarantinedFound`, showing how many old false-code records were cleaned during that run.
