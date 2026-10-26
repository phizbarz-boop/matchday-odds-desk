# Automatic discovery and clear H2H status

## Automatic operation

Pushing this update to main triggers the H2H workflow automatically. The workflow is also scheduled at minutes 07, 22, 37 and 52 every hour. No repeated manual run or website analysis is required to populate the queue.

The worker directly discovers upcoming fixtures from public SportyBet lists for all six sports supported by this app: football, basketball, ice hockey, tennis, handball and volleyball. It scans the next seven days, without dummy login or market-detail modelling. Sports are visited round-robin. Independent discovery supplements the shared public catalogue and exact fixtures queued by analysis requests.

Discovery is bounded to 90 seconds and 50 pages per sport per run. A saved per-sport cursor resumes incomplete pagination automatically. A failing sport does not prevent discovery for the others. Fixtures are saved incrementally, and page progress advances only after successful queuing. Discovery logs expose fixture counts, page progress, completion and source errors for every sport.

Collection no longer stops after the old 80-fixture limit. The default command allows up to 10,000 checks within an 11.5-minute total worker budget. A run may still finish partial when there are many matches or source failures. Unfinished fixtures remain in shared Redis and later scheduled runs continue automatically. This does not mean every fixture is checked instantly or that every SportyBet page has usable history. GitHub scheduling can be delayed, so the schedule is not an exact-time guarantee: https://docs.github.com/en/actions/how-tos/troubleshoot-workflows .

Fresh matching evidence is reused for six hours by default; it is not collected again on every run. After it expires, automatic discovery or a user request queues the fixture again. Failed reads are retried after their cooldown. New matches are picked up by subsequent discovery cycles. This requires the GitHub workflow to remain enabled and its REDIS_URL to point to the same database as Render.

## What ticket labels mean

- H2H average aligns (green): comparable historical evidence supports the selected direction. It is not a guarantee that the bet wins.
- H2H CONFLICT (red): comparable historical evidence conflicts with the selection.
- H2H READ / BET SUPPORT UNCONFIRMED (amber): the page was successfully read and matched, but the evidence cannot validate this exact bet type. Examples include a winner bet when only goals averages are available, missing sample sizes, or an unconfirmed regulation/overtime scope. The details explain the reason and show averages and lines when available.
- Queued / automatic check pending: no fresh matching saved evidence was available when this analysis ran. The external worker will attempt it automatically.
- Unavailable / unverified: the source check failed or matching fresh evidence could not be established.

Each ticket row shows the saved history check time in WAT when evidence was used. A newly completed worker run does not rewrite a ticket that is already displayed: generate a new analysis to read the updated history. Do not book an old ticket solely to refresh its label.

The hockey label remained amber because the model intentionally separates reading a page from confirming the selected bet. This update does not turn unsupported bets green, fabricate missing metrics, or change your probability floors.

## Deployment

Push the update to main and allow the automatic workflow to run. Keep SPORTYBET_H2H_ENABLED=false on Render; the website and Telegram use saved Redis history, and the browser remains in GitHub. No additional Render setting, login or Telegram booking action is required.

Local tests cover cold-start all-sport discovery, anonymous reads, pagination progress, source failures, incremental batch continuation, fresh evidence reuse and ticket status rendering. Live all-sport coverage must be judged from the deployed discovery/worker summaries; development did not run the worker against production Redis or send tickets.
