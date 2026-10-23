Football goal-kick selections

Added four explicit prematch Auto Builder selections on the website and in the Telegram bot:
- Goal Kicks Under 15.5
- Goal Kicks Under 16.5
- 1st Half Goal Kicks Under 7.5
- 1st Half Goal Kicks Under 8.5

The exact SportyBet market descriptions, under side and line determine the bet type. Actual market IDs, outcome IDs and specifiers are retained from returned data; no numeric provider IDs are guessed. Team goal kicks, second-half goal kicks, corners and goals cannot substitute for these selections. Choosing these types triggers the expanded market scan even if the additional-markets toggle is off, with ordinary football fixtures supplying event IDs. Import analysis and fresh public booking validation use the same mapping. All-sport Telegram batches can include these markets when offered and their estimated probability passes the existing floor. Bot availability follows the existing Pro/Elite builder access; Free remains Home/Draw/Away.

Probabilities use the existing complete two-outcome no-vig price estimate for that exact market, period and line. Both active Over and Under prices are required. This is market-derived, not an independent goal-kick statistics model, and does not establish empirically validated accuracy. A fixture without these offered markets will not generate fabricated goal-kick selections. Public read-only checks found no goal-kick offers in the three inspected current fixture responses, so deployed availability still depends on SportyBet coverage.

Official SportyBet pages confirm the names and lines:
https://www.sportybet.com/ng/sport/football/sr%3Acategory%3A393/sr%3Atournament%3A7/Aston_Villa_vs_Fenerbahce_Istanbul/sr%3Amatch%3A74165928
https://www.sportybet.com/tz/sport/football/International_Clubs/UEFA_Europa_League/GNK_Dinamo_Zagreb_vs_NEC_Nijmegen/sr%3Amatch%3A74172990

Goal-kick tickets require official goal-kick settlement; a final goals score cannot grade them. The fresh public-list validation fallback also preserves multi-digit market IDs as complete CSV entries, fixing character splitting in its market request.

No real bookings or Telegram sends were made during validation. Deployment required.
