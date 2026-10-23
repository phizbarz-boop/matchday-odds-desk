Highest available Under selections

Website Auto Builder and Telegram builder now have three new Under-only choices:
- Football: Throw-ins · Highest available Under (full-match total)
- Basketball: Player rebounds · Highest available Under
- Ice hockey: Player shots on goal · Highest available Under

The highest numerical threshold is selected from fresh offered data separately for each fixture and, where applicable, each player and settlement scope. Example: Under 38.5 takes priority over Under 32.5 for the same match statistic. This does not select the highest-priced odds. The highest active Under is identified before applying probability, edge and odds filters. If it fails the probability floor or lacks a complete usable Over/Under price pair, the builder does not silently downgrade to a lower line.

No new Over choice is added. Lower lines and Over outcomes for these three statistics remain readable for exact imported-ticket analysis, but are excluded from automatic builder selection. Over prices are read only to estimate the probability of the offered Under using the existing complete-outcome no-vig method. These are market-derived estimates, not a newly trained independent player-statistics model or a guarantee of winning.

Scope remains exact: match throw-ins do not use first-half/team throw-in totals. Player rebounds do not use team rebounds, points, or combined points+rebounds+assists. Player shots on goal do not use team goals or team shot totals. Each player's ID/specifier, period/overtime scope, market/outcome IDs and line are retained for booking. Existing one-selection-per-match ticket construction still applies.

Observed public provider IDs: football throw-ins 900769; basketball player rebounds 923; hockey player shots on goal 777. Focused prematch requests for only these new choices use paginated public feeds, without dummy login or per-event detail scans. Mixed-market and winner-gap requests retain the expanded-market route; fixture seeds and explicit market mappings support all three choices. Bot Pro and Elite access includes the new choices; Free remains Home/Draw/Away.

Read-only verification on 23 October 2026 inspected current event details and a one-page-per-sport feed sample. This limited feed sample returned three match throw-in highest Unders, 184 player-rebound highest Unders, and zero genuine player-shots-on-goal Unders. These are sampled selection counts, not complete-board fixture counts. The inspected hockey data offered 2+/3+/4+ milestone selections, which are not offered Under bets and are not converted into invented Under selections. The hockey choice only becomes eligible when a genuine supported Under price pair is returned.

Stat-specific selections require official settlement; final match goals/points cannot grade throw-ins, player rebounds or player shots. Existing probability floors, ticket sizes, schedule, 50-selection ceiling and ticket splitting are retained.

Validation: 478 non-browser tests passed, plus JavaScript syntax checks and read-only public-feed checks. Browser login was unchanged. No real bookings or Telegram messages were submitted. Deployment required.
