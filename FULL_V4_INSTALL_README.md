# Plot207 Full Project — Handball V4 Included

This is a FULL project ZIP rebuilt from the supplied V3 project.

It preserves the existing GitHub workflows and upgrades only the Handball collector to V4.

Included workflows:
- refresh.yml
- telegram-picks.yml
- telegram-settlement-check.yml
- sportysocial-copy-hub.yml
- copy-hub-settlement.yml
- x-copy-hub.yml
- handball-network-collector-v4.yml

The obsolete handball-network-collector-v3.yml workflow was removed.

IMPORTANT:
- This ZIP intentionally does NOT contain a `.git` folder.
- Do not delete your local `.git` folder.
- Prefer copying the contents of this ZIP into your existing repository folder after syncing with GitHub.

Handball V4 has already been proven to discover full fixture metadata including:
- eventId
- gameId
- sportId
- home/away teams
- tournament
- kickoff time
- marketId
- outcomeId
- specifier
- odds
