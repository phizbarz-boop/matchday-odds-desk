# API-Football setup — Corner History v3

Matchday Odds Desk uses API-Football as a secondary football-data source. SportyBet/Parse remains the source of real SportyBet fixtures, market IDs, odds and booking codes.

## Required Render variable

Render -> matchday-odds-desk -> Environment:

- `API_FOOTBALL_KEY` = your API-Football key

`API_FOOTBALL_API_KEY` is also accepted as an alias. Never expose the key in `public/index.html` or commit it to GitHub.

## What Corner History v3 does

1. Reads actual upcoming SportyBet football fixtures.
2. Matches them to API-Football by teams + kickoff time.
3. Builds recent corner attack/concession profiles from the latest team matches.
4. Loads a cached completed-season profile for the same league/team.
5. Blends recent form with last-season home/away attack and opponent-conceded corner rates.
6. Uses empirical hit-rates for common lines (FT O6.5/O7.5/O8.5/O9.5, U12.5/U13.5, and team O1.5–O4.5) as a second check on Poisson probability.
7. Uses **actual first-half corner statistics** from API-Football `half=true`; it does not estimate 1H corners as a fixed percentage of full-time corners.
8. Separates SportyBet match-total corners from team-corner markets so a team O2.5 line cannot be scored as match O2.5.
9. Applies corner-specific red-flag protection before website Auto Builder accepts a corner selection.

## Important: build the historical cache once after deployment

GitHub -> Actions -> **Build Corner History** -> Run workflow.

Default completed season:

- `2025` means the **2025/26** season.

Default API-Football league IDs:

- `39` Premier League
- `140` La Liga
- `135` Serie A
- `78` Bundesliga
- `61` Ligue 1
- `2` UEFA Champions League
- `40` Championship
- `88` Eredivisie
- `94` Primeira Liga

The workflow calls the protected endpoint:

`POST /api/corners/history/rebuild`

The historical cache is stored in Redis when `REDIS_URL` is configured. Without Redis it is stored under `data/corner-history-<league>-<season>.json` on that running instance.

After the history build finishes, run **Daily Predictions Refresh** once so upcoming matches receive the new historical corner model.

## Recommended Render variables

```text
API_FOOTBALL_CORNER_HISTORY_LEAGUES=39,140,135,78,61,2,40,88,94
API_FOOTBALL_CORNER_HISTORY_SEASON=2025
API_FOOTBALL_CORNER_HISTORY_WEIGHT=0.55
API_FOOTBALL_CORNER_LEAGUE_BASELINE_WEIGHT=0.10
CORNER_EMPIRICAL_WEIGHT=0.40

API_FOOTBALL_CORNER_LAST_MATCHES=8
API_FOOTBALL_CORNER_STAT_FALLBACK_CALLS=10
API_FOOTBALL_MAX_FIXTURES=180
API_FOOTBALL_SPORTY_MAX_PAGES=12
API_FOOTBALL_ON_DEMAND_CORNER_FIXTURES=20
API_FOOTBALL_BUILD_ALL_CORNER_PROFILES=true
API_FOOTBALL_MIN_INTERVAL_MS=120
API_FOOTBALL_LOG_CALLS=true

SPORTYBET_CORNERS_MARKET_QUERY=Corners
SPORTYBET_TEAM_CORNERS_MARKET_QUERY=Team Corners
SPORTYBET_1H_TEAM_CORNERS_MARKET_QUERY=1st Half Team Corners
```

`API_FOOTBALL_1H_CORNER_SHARE` is obsolete in this version and is ignored by the corner model.

## Corner red-flag protection

Website Auto Builder rejects a corner selection when, among other checks:

- completed-season history is unavailable;
- FT historical sample is below 12 matches;
- actual 1H sample is below 8 matches for a 1H selection;
- recent sample is below 4 matches;
- recent and historical expected corners disagree by more than 20%;
- Poisson probability and empirical hit-rate disagree by more than 15 percentage points;
- expected corners are too close to the selected betting line.

These checks apply to corner candidates only. Other existing football bet types retain their current behavior.

## Supported corner families

### Full-time match corners
- Over/Under lines returned by SportyBet.
- Historical empirical support is strongest for O6.5/O7.5/O8.5/O9.5 and U12.5/U13.5.

### Full-time team corners
The website and Auto Builder expose:
- `FT Home Team Corners O/U (1.5–4.5)`
- `FT Away Team Corners O/U (1.5–4.5)`

### First-half team corners
The website and Auto Builder expose:
- `1H Home Team Corners O/U (1.5–4.5)`
- `1H Away Team Corners O/U (1.5–4.5)`

A 1H candidate is not produced unless actual historical half data exists.

## Diagnostics

- `/api/api-football/diagnostics` — confirms API-Football connectivity without exposing the key.
- `/api/corners/diagnostics` — shows SportyBet match-corner, FT-team-corner and 1H-team-corner row counts plus modeled matches.
- `/api/corners/test-live` — tests the full live SportyBet -> API-Football -> corner-model path on one real fixture.

## Typical deployment order

1. Deploy this version.
2. Confirm `API_FOOTBALL_KEY`, `REDIS_URL`, `REFRESH_SECRET`, and Parse/SportyBet variables exist on Render.
3. Run **Build Corner History** for season `2025` and the league IDs you want to trade.
4. Check Render logs for `CornerHistory DONE ...` messages.
5. Run **Daily Predictions Refresh** once.
6. Open `/api/corners/diagnostics`.
7. Use the Auto Builder. Corner selections without valid history will be filtered rather than guessed.

## API-credit note

The history build intentionally makes one fixture-statistics request per completed match in each configured league, because this is what gives the model real FT and 1H empirical distributions. Do not rebuild an already cached completed season unless necessary. Use `force=true` only when you intentionally want to refresh the cache.
