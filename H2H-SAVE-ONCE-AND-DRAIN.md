# Save once per fixture and drain the backlog

The supplied run checked 132 and saved 116 in 11.5 minutes, leaving 1,087 queued entries. At that observed check rate the remaining queue requires roughly another 95 minutes of continuous processing, before allowing for slower responses, unavailable history or retries. Discovery completion does not mean history collection completion.

The external entry point now permits a 100-minute collection window instead of 11.5 minutes. The workflow allows 105 minutes for collection and 120 minutes overall. Existing workflow concurrency still prevents overlapping worker jobs; later scheduled runs resume remaining Redis queue entries. API limits and browser source failures still apply. This is a bounded long-running collection job, not instantaneous processing.

Successful H2H snapshots are retained through the scheduled fixture plus one day (bounded retention). Identity and timestamp validation remain, with an eight-day snapshot age ceiling matching the seven-day discovery horizon. Existing usable entries migrate to the extended retention on their next cache read without changing their original capture timestamp. Saved snapshots no longer automatically expire after six hours or trigger SportyBet-to-API upgrade attempts. Later app deployments do not reset the Redis queue or history.

Each successful collection is saved before the next fixture starts. A cancelled run therefore resumes unfinished items. Failed reads remain eligible for cooldown-based retry, with first checks prioritized. A manual run of the full queue respects cooldowns; force retry is reserved for a targeted single-fixture diagnostic. No usable history is fabricated for unavailable pages.

Coverage counters now distinguish existing saved evidence from fixtures that have never been attempted. H2H collection stays limited to football and basketball. Other sports remain available without H2H verification.

Push the update normally; the workflow runs for relevant source changes and continues on its existing schedule. Keep Render SPORTYBET_H2H_ENABLED=false. No Redis reset is needed. Run a new website analysis to read completed history. A retained snapshot is an as-of historical check, not continuously refreshed form data.
