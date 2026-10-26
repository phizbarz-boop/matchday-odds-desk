# Shared API H2H name matching

Replaces the need for individual club aliases for common edge designators. The scheduled-fixture matcher now recognizes generic football FC/CF/AFC/SC/AC, basketball BC/BK/Basket/Basketball, hockey HC/HK, handball HC/HK/HB and volleyball VC/VK at the beginning or end of a club name. Existing verified aliases and Unicode/accent/punctuation normalization remain.

Both opponents and a kickoff within the existing 90-minute tolerance must match a unique provider fixture with different integer team IDs. Short cores, arbitrary abbreviations, missing location words, and youth/women/reserve differences are not guessed. Competing provider identities remain unresolved. This does not provide a universal identity database.

If football's full-name team search returns no results, it tries one bounded core-name search. A nonempty ambiguous response is not bypassed by another search. The returned unique IDs are verified before requesting direct H2H history. Existing request budgets and cache behavior remain.

The shared scheduled matcher covers all existing API adapters, but automatic H2H discovery and verification remain limited to football and basketball as requested. Tennis has no configured API-Sports adapter. Other sports are not re-enabled by this change.

This fixes common naming differences; it cannot create unavailable provider fixtures or historical statistics. SportyBet fallback is retained for genuinely missing data and unsupported market metrics. Live private API access was not used during validation.
