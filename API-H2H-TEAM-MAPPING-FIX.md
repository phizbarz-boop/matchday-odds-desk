# Football team mapping and diagnostics

The supplied live test successfully authenticated, verified Football Pro (7,500/day), read the cached SportyBet fixture identity, then returned API_FIXTURE_UNMAPPED. That means the old exact scheduled-fixture matcher did not find one unique pair with matching names and kickoff within 90 minutes. The old report did not expose the provider's candidate names or returned fixture count, so it cannot establish whether the cause was name variation, timing, or missing upcoming fixture coverage.

This update makes two bounded improvements:

1. Explicit football club-name equivalents support Bournemouth/AFC Bournemouth and Leeds/Leeds United. These aliases preserve youth, women and reserve qualifiers. They are not a fuzzy similarity threshold.
2. When an upcoming football fixture cannot be matched, the collector queries each club through the documented /teams search endpoint. Each must resolve to one unique API team ID, with country checked where a usable country name is known. Only then does it request H2H for that verified pair. A matching upcoming API fixture is not required to retrieve the pair's historical meetings.

The response now distinguishes mappingBasis=scheduled_fixture_and_teams from mappingBasis=verified_team_ids_without_scheduled_fixture. In the latter case providerFixtureId is null, while providerTeamIds identifies the verified pair. Historical results still must be finished, past, between those same IDs and deduplicated. This change does not claim that the future fixture was verified in the API when only the team identities were verified.

Ambiguous or unknown teams remain rejected. The test prints bounded public diagnostics with expected SportyBet names/kickoff, provider fixture count, nearby candidate names and team-search candidates. Those candidates are diagnostic only; token similarity never selects a team. API keys, headers, account emails and raw error responses are not printed.

An uncached football fallback requires two additional team-search requests. Verified search responses are cached for seven days in the automatic worker. Existing per-sport request limits still apply. No booking or Telegram behavior changes.

After pushing this update, start a NEW Plot207 API-Sports H2H Test run on main with event_id=sr:match:72221354. Do not rerun the job from the old commit. If successful, the report includes providerTeamIds and historical games/metrics. If it still fails, the new mapping diagnostics provide the evidence needed to resolve that specific mismatch.

The live paid API result cannot be confirmed during development without access to the configured private key. Local mocked tests cover the supplied name variants, no-upcoming-fixture fallback, ambiguous club rejection, youth qualifier preservation and diagnostic output. No production account, Redis data, booking or Telegram message was changed during development.
