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

- Football: 1X2, GG/NG, Double Chance, Draw No Bet, Over 1.5 Goals, Under 4.5 Goals, Asian Handicap +0 / +0.25 / -0.25
- Over/Under 2.5 is intentionally excluded from the Auto Builder
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
GET /api/sportybet/odds?market=dc
GET /api/sportybet/odds?market=dnb
GET /api/sportybet/odds?market=ou15
GET /api/sportybet/odds?market=ou45
GET /api/sportybet/odds?market=ah

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

- Football 1X2, GG/NG, Double Chance, Draw No Bet, Over 1.5, Under 4.5 and Asian Handicap 0/±0.25 using Poisson + capped H2H probabilities.
- DNB and Asian quarter-handicap EV/fair odds are settlement-aware: pushes, half wins and half losses are explicitly priced.
- O/U 2.5 is not used by the Auto Builder.
- Basketball Winner using no-vig SportyBet market probability.
- Ice Hockey Winner using no-vig SportyBet market probability.

It uses controlled probability-weighted randomness, allows only one selection per event,
and searches many possible combinations for combined odds close to the requested target.
The frontend exposes both **Auto Pick Best Bets** and **Auto Pick + Generate Code**.

No additional Render environment variable is required for this feature. It reuses
`PARSE_API_KEY`, the existing SportyBet cache settings, and the existing football prediction data.

## Booking Code Analyzer

The website includes a Booking Code Analyzer for SportyBet share/booking codes created outside Matchday Odds Desk.

Flow:
1. Paste the outside SportyBet booking code.
2. Choose the minimum probability to keep (for example 60%).
3. Press **Analyze Code**.
4. Each supported leg is matched to the current Matchday probability/value engine and marked **KEEP** or **REMOVE**.
5. Unsupported markets are shown as **NOT SCORED**; the app never invents a probability for them.
6. Press **Generate New SportyBet Code** to rebuild a code from only the qualifying selections.

The analyzer uses the same `PARSE_API_KEY` already configured in Render. It retrieves existing booking-code details through Parse's SportyBet `get_booking` endpoint. The default decoder scraper is built in. To override it, add this optional Render environment variable:

```text
PARSE_BOOKING_SCRAPER_ID=8ffd9f0c-6174-43af-80dc-4898f47f074b
```

The booking lookup is a separate Parse request and therefore consumes the credits charged by that endpoint. Current market data may also be fetched if it is not already cached.


## Booking Code Analyzer extended horizon

The Analyzer uses its own future-match window and does not change the normal Auto Builder horizon. Optional Render variables:

```text
ANALYZER_DAYS=14
ANALYZER_MAX_PAGES=12
PREDICTION_DAYS_AHEAD=21
```

The website lets the user choose 7, 14, or 21 days for each analysis. The build defaults the football prediction refresh to 21 days so all three Analyzer choices can be scored when football-data.org exposes the fixture. You may explicitly set `PREDICTION_DAYS_AHEAD=21` in Render to make that behavior visible in your configuration. `SPORTYBET_HOURS` can remain at 120 for the normal Auto Builder.

### Analyzer generic Over/Under resolution

Some Parse `get_booking` responses return an imported football Over/Under leg with the correct fixture and booked odds but use the generic outcome label `Selection` instead of the actual line/outcome. The Analyzer now repairs this before probability scoring:

1. It first matches the leg against the live SportyBet `Over 1.5` market by event/team and price.
2. When the same booking contains explicit `Over 1.5` legs and no conflicting explicit O/U outcomes, remaining generic O/U legs are classified as `Over 1.5` for model matching.
3. Re-booking IDs are never invented; a new booking code is created only from selections that ultimately match a real current SportyBet candidate.
4. If Over 1.5 is resolved but the football prediction database has no matching fixture/competition, the UI says so instead of incorrectly reporting that the imported market itself is unsupported.


## Cross-slip diversification

Optional Render variable:

```text
TELEGRAM_REPEAT_MIN_PROBABILITY=80
```

During one Telegram auto-pick run, the same **game + bet type** is not reused in another target-odds slip when its probability is below this threshold. Picks at or above the threshold may repeat.
