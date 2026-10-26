# H2H scope: football and basketball only

H2H discovery, queued collection, saved-history assessment, and ticket verification now apply only to football and basketball. Tennis, handball, volleyball, and ice hockey remain available for ordinary predictions without H2H filtering.

The worker discards legacy queue entries for excluded sports. Existing history is retained in storage but is not used to assess those sports. Excluded sports do not receive H2H warning badges or enter the website ticket H2H counts. Football and basketball keep their existing collection and verification rules.

Deploy normally and start a new analysis. No Redis clearing or new environment variable is required. Keep Render SPORTYBET_H2H_ENABLED=false; external workers collect history and the website reads the cache.
