# Corners and daily Telegram picks

The existing 07:00 and 18:00 WAT batches now contain 17 ticket plans.

New football plans (70% per-selection model floor):
- Corners Under 11.5 / Under 12.5: up to 10 different matches in one ticket.
- Corners Under 11.5 / Under 12.5 long shot: up to 30 different matches, within the next seven days.
- Goal Kicks Under 15.5: its own ticket, up to 10 matches.
- Goal Kicks Under 16.5: its own ticket, up to 10 matches.

All six existing sport long-shot tickets now stop at 30 games. The platform's overall 50-selection booking limit remains unchanged. Short tickets prefer today, with tomorrow used for top-ups. Partial tickets are sent when fewer games qualify; an empty plan sends an availability notice instead. Codes continue to be saved in Today's Codes. Manual workflow runs still permit repeated test selections.

Corners now request the public fixture feed's verified market 166 directly. Website corner cards also include fixtures returned by this feed even when absent from general predictions. Website and bot choices distinguish Under 11.5 from Under 12.5; provider market IDs, outcome IDs and line specifiers remain intact. Public data collection does not require the dummy login. Goal-kick tickets receive a dedicated bulk public read rather than depending solely on event-detail enrichment.

The existing corner probability pipeline is preserved: available displayed historical corner statistics feed the Poisson model; otherwise a complete current Over/Under price pair supplies the existing margin-adjusted market estimate. Goal-kick estimates likewise require complete current price pairs. These estimates are not guarantees of results, and a 70% floor does not imply that enough offered games exist to fill every ticket.

Already completed or uncertain booking checkpoints are preserved during the update. Cached unfinished 50-game plans are capped at 30; new plans are appended without booking completed plans again. Previously completed scheduler slots are not reopened: use a new manual workflow run to test this release.

Verification: 482 non-browser tests passed in the full suite; three additional regression tests passed for website corner rendering, dedicated ticket contents/caps and cached-plan migration (485 tests covered in total). Public read-only smoke check confirmed market 166 offers the requested corner lines and returned eligible Under 12.5 selections in a 100-fixture sample. No real bookings or Telegram messages were sent during verification.

Deploy by replacing the project files and pushing to the connected repository. No new environment variables are required. Reload the website after deployment.
