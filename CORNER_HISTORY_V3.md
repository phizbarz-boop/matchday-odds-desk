# Corner History v3 — Matchday Odds Desk

This build upgrades only the football corner pipeline while keeping the existing goal, 1X2, Telegram, booking-code and other sports features intact.

## Best corner profiles the engine now searches for

1. **FT Team O2.5 Corners** — strongest when the attacking team's historical hit-rate and the opponent's conceded hit-rate agree.
2. **FT Match O7.5 Corners** — core total-corner line when season + recent form support it.
3. **FT Match O6.5 Corners** — safer low-line option when the SportyBet price is still useful.
4. **FT U12.5 / U13.5 Corners** — low-corner alternative when the historical matchup supports an under.
5. **1H Team Corners** — only scored when real first-half API-Football history exists; no fixed percentage approximation.

The Auto Builder does not blindly hard-code these picks. It scores the actual SportyBet lines and chooses only selections that pass probability, empirical-history and red-flag checks.

## Model inputs

- Recent team corners won and conceded (`API_FOOTBALL_CORNER_LAST_MATCHES`, default 8).
- Previous completed season, all matches in configured leagues.
- Home-only profile for the home team.
- Away-only profile for the away team.
- Opponent corners conceded.
- Empirical hit-rate at the exact betting line.
- Poisson line probability as a separate statistical estimate.
- League average as a small stabilizer.
- Actual 1H corner statistics from API-Football `half=true` where covered.

## Default completed-season leagues

The manual **Build Corner History** workflow defaults to the leagues shown on the website:

`39,140,135,78,61,2,40,88,94`

(Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League, Championship, Eredivisie, Primeira Liga.)

## Required first deployment step

After deploying this ZIP, run:

**GitHub -> Actions -> Build Corner History -> season 2025**

Then run:

**GitHub -> Actions -> Daily Predictions Refresh**

Without the completed-season cache, corner selections are deliberately rejected by Auto Builder red-flag protection instead of being guessed.
