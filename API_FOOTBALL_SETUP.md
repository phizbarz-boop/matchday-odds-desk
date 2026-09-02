# API-Football setup

Matchday Odds Desk uses API-Football as a secondary football-data source. SportyBet/Parse remains the source of SportyBet fixtures, market IDs, odds and booking codes.

## Required Render variable

Render -> matchday-odds-desk -> Environment -> Add Environment Variable

- `API_FOOTBALL_KEY` = your API-Football key

Do not put the key in `public/index.html` or commit it to GitHub.

The integration also accepts `API_FOOTBALL_API_KEY` as an alias, but `API_FOOTBALL_KEY` is recommended.

## What the integration does

1. Reads actual upcoming SportyBet football fixtures.
2. Matches them to API-Football fixtures by teams and kickoff time.
3. Uses API-Football predictions to add model coverage for SportyBet fixtures outside the older football-data.org league list.
4. Uses recent API-Football fixture statistics to estimate total-corner rate for SportyBet fixtures that expose a corners market.
5. Builds SportyBet-compatible corner selections only from the market/outcome IDs returned by Parse.

## Optional tuning variables

- `API_FOOTBALL_MAX_FIXTURES=180` — max SportyBet fixtures enriched per daily refresh.
- `API_FOOTBALL_CORNER_LAST_MATCHES=8` — recent matches per team used for corner averages.
- `API_FOOTBALL_CORNER_STAT_FALLBACK_CALLS=6` — maximum individual statistics calls per team when batch fixture details have no statistics.
- `API_FOOTBALL_MIN_INTERVAL_MS=120` — minimum spacing between API-Football calls.
- `API_FOOTBALL_SPORTY_MAX_PAGES=12` — SportyBet pages scanned by the enrichment job.
- `SPORTYBET_CORNERS_MARKET_QUERY=Corners` — override only if your Parse SportyBet scraper names the corner market differently.

## After deployment

Run GitHub -> Actions -> Daily Predictions Refresh -> Run workflow once. The workflow calls the protected Render `/api/refresh` endpoint, so the API-Football key only needs to be present in Render.

The refresh can take longer than before because it performs fixture matching, API-Football predictions and recent corner-statistics lookups. Results are written to the existing Redis `predictions:latest` key.
