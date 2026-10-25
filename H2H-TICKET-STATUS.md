# H2H status on the generated ticket

Each website slip selection now shows one of:
- H2H: Checked · history used — a comparable historical adjustment was applied.
- H2H: Checked · limited evidence — the page was verified, but there was insufficient comparable evidence or no calibrated adjustment for that market. This does not assert prediction accuracy.
- H2H: Unavailable / unverified — the attempt did not produce fresh matching evidence. The original model estimate is retained.
- H2H: Not checked — no check was recorded, or the fixture was not reached within the check/time limit. These matches remain eligible.

The slip has its own selection-level count, separate from the candidate-pool fixture count. The pool summary says “H2H attempted” because failed reads also consume an attempt. Missing/unverified fixtures are not removed. Existing H2H limits and scheduling remain unchanged.

Statuses are retained with saved website slip selections. Generate a fresh ticket after deployment for explicit attempted-versus-not-checked metadata; older tickets cannot reconstruct whether an old unavailable result was attempted. The feature does not fetch more H2H pages or add scan memory load.

Validation: focused tests cover labels, per-ticket counts, verified/failed/unattempted fixtures and website script syntax. The complete non-browser suite passes 523 tests. No real tickets were booked or Telegram messages sent.
