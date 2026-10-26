# API-Football Burgos mapping fix

The supplied diagnostic matched the date, kickoff and opponent for SportyBet FC Andorra vs Burgos CF, event sr:match:72477520. API-Football lists fixture 1569983 as FC Andorra vs Burgos. The missing explicit club-name equivalent prevented the scheduled fixture from mapping and the subsequent literal team search returned no results.

Added the explicit football equivalent Burgos CF -> Burgos. Both opponents, kickoff proximity, unique scheduled match and integer provider team IDs remain required. Youth, women and reserve qualifiers are retained. No general removal of club prefixes or suffixes was introduced.

The read-only API test report now checks only football and basketball, consistent with the configured H2H collection scope. Other sports remain available for predictions without H2H checks.

After deploying, rerun Plot207 API-Sports H2H Test with event ID sr:match:72477520. The mapping can now reach the H2H endpoint; usable returned history is still required for success. API_HISTORY_UNAVAILABLE means no usable completed history was returned, which is separate from this naming error. Automatic collection still retains SportyBet fallback for unavailable API history or missing market statistics.

Validation used mocked API responses based on the supplied diagnostic. No private API credentials or production Redis were used.
