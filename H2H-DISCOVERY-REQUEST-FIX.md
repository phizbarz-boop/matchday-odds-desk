# Correct public discovery requests

The supplied log confirms that round-robin H2H collection ran across all six sports and saved 78 of 107 checked fixtures from the existing shared queue. Independent discovery failed with pages=0 for every sport.

The discovery request incorrectly omitted marketId by passing an empty market-ID list. A direct public read reproduced HTTP 422 with SportyBet's Invalid response for all six sports. Sending the existing configured per-sport market IDs returned valid first pages for football, basketball, ice hockey, tennis, handball and volleyball. The correction uses the same market-ID configuration as the app's working public catalogue reader. No dummy login is needed.

Discovery errors now retain sanitized upstream HTTP status and an error code, so future logs distinguish a rejected request from a missing H2H panel. Raw upstream messages, secrets and credentials are not logged by discovery.

After pushing, the automatic H2H workflow starts and subsequent scheduled runs continue incomplete work. No repeated manual runs are required. The existing Redis queue and saved history are retained. Keep SPORTYBET_H2H_ENABLED=false on Render.

Some fixtures still do not expose Stats/H2H tabs; other pages have no comparable metrics or no recorded sample size. This fix does not fabricate history or turn those selections green. Tennis pages with no parsed market metric remain insufficient for confirming a particular bet. A new analysis reads the latest saved evidence; previously displayed tickets are not rewritten automatically.

Validation includes anonymous public first-page requests for all six sports and local automated tests. Development did not write to production Redis, generate booking codes or send Telegram tickets. Live GitHub discovery totals should be checked after deployment because that runner has a different network environment.
