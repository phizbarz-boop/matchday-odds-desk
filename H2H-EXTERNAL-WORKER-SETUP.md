# Set up H2H collection outside Render

This release makes the website, imported-code analyser, Telegram bot builder and daily Telegram packs read shared H2H evidence from Redis. They do not open Chromium for H2H. Missing, expired, mismatched or unavailable evidence does not remove a selection; the existing model estimate remains and the ticket is marked unconfirmed. Existing probability floors and verified historical conflict rules are preserved.

## One-time setup

1. Deploy this complete source ZIP using the supplied command.
2. Keep `SPORTYBET_H2H_ENABLED=false` on Render. The new Redis history reader works independently of this legacy browser switch. Keep the working Render `REDIS_URL`. Do not set `SPORTYBET_H2H_WORKER=true` on Render.
3. In the GitHub repository, add an Actions repository secret named `REDIS_URL`. Copy the same full Redis connection URL already used in Render, including its credentials and TLS scheme where applicable. Never paste it into chat or a source file. A Render-only internal Redis address cannot be reached by GitHub; use the Redis provider's externally reachable connection URL to the same database.
4. After the new workflow is on the main branch, open GitHub Actions and run **Plot207 H2H History Worker** manually once.
5. The worker seeds upcoming fixtures from the shared public catalogue and also processes identities queued by analyses. If there are no pending/catalogue fixtures, run an Auto Analysis once, then run the worker again. The first ticket may show “Queued for the separate H2H worker”.
6. Inspect the final `[H2H external worker]` summary. `saved` greater than zero means verified evidence was stored. A successful run with no queued fixtures does not prove any H2H was collected. If `saved=0` and failures are reported, inspect `reasons`; the failed source/browser/page checks must still be resolved.
7. Generate a fresh ticket to use the stored evidence. Ticket labels show the saved capture time in WAT. Existing displayed tickets are not automatically rescored after the worker updates Redis.

## Operation

The new GitHub workflow requests a run every 15 minutes and allows manual runs. GitHub can delay scheduled starts; it is not an exact-time service. It does not send Telegram messages or book tickets. All previous pick schedules and types stay unchanged.

A run processes up to 80 fixtures by default, within an eight-minute scheduling budget and a 60-second per-fixture cancellation budget. GitHub's overall job limit is 15 minutes. Public catalogue seeding considers up to 400 upcoming fixtures across sports and the next seven days; requests enqueue exact candidate fixture IDs. The collector reads whatever old/new H2H dates the public pages supply, with no one-year cutoff on historical results. The seed primarily covers upcoming events; live selections can use still-fresh history collected before kickoff.

Verified captures are usable for six hours by default (`SPORTYBET_H2H_CACHE_MAX_AGE_SECONDS`, 15-minute minimum, one-day maximum). Expiration refers to capture freshness, not historical result dates. Set a matching value on Render and the worker if changing it. Stored evidence expires after one day, queued identities after two days, failure explanations after 15 minutes, and the worker status after one day. Name/fixture identity and future-timestamp checks still apply. H2H availability varies by sport and market; a verified page with no comparable metric does not become a calibrated historical probability.

The website reads up to 1,000 distinct fixture records per batch in Redis groups of 100, with a three-second response budget. It never falls back to collecting in the web process when Redis or the worker fails. `SPORTYBET_H2H_CACHE_ENABLED=false` explicitly disables even the shared-cache checks; leave it unset or true for this feature.

The signed-in website endpoint `/api/sportybet/h2h/status` reports external-cache mode and the latest worker summary. It does not expose Redis credentials. Source failures remain visible in per-selection labels.

## Validation and limits

The complete non-browser suite passes 548 tests. New tests cover worker-to-web persistence, disabled legacy browser mode with active cache checks, queue deduplication, stale/future/wrong-team rejection, worker failures, Redis outages, browser-launch refusal on the web process and browser-free public builds. No production Redis writes, workflow execution, Render deployment, real booking or Telegram send were performed here. Public SportyBet collection from the GitHub runner still needs verification on the first real worker run.

Reader update: tab clicks now search visible document frames, tolerate whitespace in H2H (New), and read the new summary before the old view. Manual workflow dispatch bypasses the 15-minute failed-read cooldown. Start a NEW workflow run after updating; re-running an old failed job may use the old commit. Per-fixture logs now show tab/panel diagnostics and the precise failed stage.
