# Verified Copenhagen name equivalent

The supplied authenticated diagnostic identifies the same scheduled match in both sources:

- SportyBet event sr:match:74994258: Aarhus Fremad vs Copenhagen, 2026-10-29 12:30 UTC.
- API-Sports fixture 1640475: Aarhus Fremad vs FC Copenhagen, exactly the same kickoff.
- API teams: Aarhus Fremad 6004 and FC Copenhagen 400. AB Copenhagen 2060 and FC Copenhagen W 27632 were also returned by the broad team search and must not be confused with the selected club.

The strict mapper rejected Copenhagen versus FC Copenhagen because that explicit name equivalent was absent. The football alias registry now maps Copenhagen to FC Copenhagen. No generic removal of club prefixes or fuzzy team guessing is introduced. AB Copenhagen, FC Copenhagen W, youth and reserve identifiers remain distinct. Duplicate eligible provider identities still fail closed.

Targeted tests reproduce the exact supplied fixture and verify rejection of the other Copenhagen clubs, women/youth variants and ambiguous IDs. All 25 API integration tests passed. This is a name-equivalence correction only; no request-budget or probability rule changed.

After pushing this update, start a NEW Plot207 API-Sports H2H Test on the updated main branch using sr:match:74994258. The mapping should now select providerFixtureId 1640475 and providerTeamIds home=6004, away=400. The next test must still establish whether usable historical meetings/statistics exist; successful fixture matching alone does not prove historical coverage or predictive accuracy.

Existing API key, enabled flag, football budget and Render settings remain unchanged. No live authenticated requests, production Redis writes, bookings or Telegram sends were performed during development.
