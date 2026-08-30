# Matchday Odds Desk — Multi-Sport SportyBet + H2H setup

## Render environment variables

Required:

```text
PARSE_API_KEY=your_parse_api_key
FOOTBALL_DATA_TOKEN=your_football_data_token
```

Recommended:

```text
SPORTYBET_CACHE_SECONDS=43200
SPORTYBET_HOURS=120
SPORTYBET_MAX_PAGES=5
SPORTYBET_PAGE_SIZE=100
SPORTYBET_BOOKINGS_PER_MINUTE=5
H2H_PREVIOUS_SEASONS=1
H2H_MAX_MEETINGS=8
H2H_MAX_WEIGHT=0.18
```

`PARSE_SCRAPER_ID` is optional. The current SportyBet Nigeria scraper ID is already the default in `lib/sportybet.js`.

## Sports and markets

The UI now has three sport sessions/tabs:

- Football: 1X2, GG/NG, Over/Under 2.5
- Basketball: Winner incl. overtime, Handicap incl. overtime, Over/Under incl. overtime
- Ice Hockey: Winner/1X2, Puck Line/Handicap, Over/Under Goals

Basketball and hockey percentages shown by the dashboard are no-vig market probabilities derived from SportyBet odds. They are not an independent historical-statistical model.

## Multi-game SportyBet booking code

Every selectable SportyBet outcome carries its `eventId`, `marketId`, `outcomeId`, and optional `specifier` into the browser betslip. The browser sends all selected legs to:

```text
POST /api/sportybet/book
```

The backend calls Parse `book_bet` once and returns the SportyBet `shareCode`, `shareURL`, deadline and any unavailable selections. The API key never reaches the browser.

The slip permits one selection per event. Choosing another outcome from the same event replaces the previous selection.

## H2H-adjusted football probabilities

The refresh job now loads completed matches and finds previous direct meetings for every upcoming football fixture. Recent meetings receive more weight. H2H influence is 3 percentage points per meeting and is capped by `H2H_MAX_WEIGHT` (18% by default).

Example: 5 previous meetings => 15% H2H influence and 85% current Poisson/form model.

The dashboard displays:

- number of H2H meetings used
- H2H home/draw/away percentages
- H2H model influence
- up to five recent H2H scores
- the original Poisson 1X2 probabilities for comparison

### football-data.org history limitation

The free football-data.org plan focuses on current fixtures/results/tables. Historical-season access can depend on your subscription. The code therefore treats previous-season H2H retrieval as best-effort: if the API returns 403, refresh continues with current-season history and the H2H influence becomes 0 when no direct meeting is available.

For deeper historical H2H, use a football-data.org plan with history access (for example their ML history offering) or plug another historical-results provider into `getFinishedMatches()`.

## New API routes

```text
GET /api/sportybet/odds?market=1x2
GET /api/sportybet/odds?market=gg
GET /api/sportybet/odds?market=ou

GET /api/sportybet/sport/basketball?market=winner
GET /api/sportybet/sport/basketball?market=handicap
GET /api/sportybet/sport/basketball?market=totals

GET /api/sportybet/sport/hockey?market=winner
GET /api/sportybet/sport/hockey?market=handicap
GET /api/sportybet/sport/hockey?market=totals

POST /api/sportybet/book
```

## Deploy

Commit the modified project to the GitHub repository connected to Render, add the environment variables above, and redeploy. Run the normal refresh job once after deploying so stored football predictions include the new H2H fields.

## Automatic target-odds bet builder

This version also includes a server-side automatic slip builder.

Endpoint:

```text
POST /api/sportybet/auto-pick
```

Example JSON body:

```json
{
  "targetOdds": 5.0,
  "minProbability": 55,
  "maxSelections": 8,
  "leagues": ["Premier League", "La Liga", "Serie A"]
}
```

The auto builder scans:

- Football 1X2, GG/NG and Over/Under 2.5 using the Poisson + H2H model probability.
- Basketball Winner using no-vig SportyBet market probability.
- Ice Hockey Winner using no-vig SportyBet market probability.

It uses controlled probability-weighted randomness, allows only one selection per event,
and searches many possible combinations for combined odds close to the requested target.
The frontend exposes both **Auto Pick Best Bets** and **Auto Pick + Generate Code**.

No additional Render environment variable is required for this feature. It reuses
`PARSE_API_KEY`, the existing SportyBet cache settings, and the existing football prediction data.
