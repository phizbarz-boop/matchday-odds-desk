# H2H coverage queue fix

Finding a fixture is different from collecting its H2H history and verifying support for a particular market. The reported run discovered approximately 1,800 fixtures but checked 94 and saved 71 within its collection budget. Browser collection is serial and continues in later scheduled batches.

Previously, ready retries and API upgrades for already-cached fixtures competed with first checks. The worker now prioritizes never-attempted fixtures globally, rotates across sports within each priority tier, and checks earlier kickoffs first within a sport. It records attempts persistently so expired failure records cannot make a failed fixture look new.

Known missing statistics tabs or H2H panels retry after one hour. Other collection failures retain the 15-minute retry interval. Manual force retry remains available. Fresh evidence continues to use the existing six-hour freshness setting.

The worker summary adds `coverageBefore` (first checks, retries, upgrades, deferred retries, fresh skips), `awaitingFirstCheck`, and `previouslyAttemptedPending`. These distinguish queue progress from source availability. A saved page is not proof that every market has comparable historical evidence.

Push this update normally. The updated H2H workflow starts on relevant source changes and subsequent scheduled runs continue the queue. Keep Render `SPORTYBET_H2H_ENABLED=false`; browser collection stays in the external worker and the app reads saved history. Matches without usable H2H remain available, as requested.

Validation: 606 automated tests passed, including first-check priority across sports, API-upgrade ordering, cooldowns, persistent attempts, and fresh-cache reuse. Production provider coverage was not tested with private credentials.
