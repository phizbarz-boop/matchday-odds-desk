# SportyBet Diagnostic Build

This build intentionally keeps stale-fixture protection ON while adding diagnostics, so we can prove where rows disappear.

Render logs now print:
`[SportyBet diagnostic] raw=... validKickoff=... invalidKickoff=... pastOrStarted=... upcoming=... kickoffSamples=[...]`

Interpretation:
- raw=0 -> upstream Parse/SportyBet returned no rows.
- raw>0 + invalidKickoff high -> kickoff field/parser mismatch.
- raw>0 + pastOrStarted high -> dates parse but appear expired/started.
- upcoming>0 -> rows survived stale filtering.

No diagnostic line contains API keys or tokens.
