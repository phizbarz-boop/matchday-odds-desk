# H2H status on the generated ticket

Each website slip selection now shows one of:
- H2H: Checked · history used — a comparable historical adjustment was applied.
- H2H: Checked · limited evidence — the page was verified, but there was insufficient comparable evidence or no calibrated adjustment for that market. This does not assert prediction accuracy.
- H2H: Unavailable / unverified — the attempt did not produce fresh matching evidence. The original model estimate is retained.
- H2H: Not checked — no check was recorded, or the fixture was not reached within the check/time limit. These matches remain eligible.

The slip has its own selection-level count, separate from the candidate-pool fixture count. The pool summary says “H2H attempted” because failed reads also consume an attempt. Missing/unverified fixtures are not removed. Existing H2H limits and scheduling remain unchanged.

Statuses are retained with saved website slip selections. Generate a fresh ticket after deployment for explicit attempted-versus-not-checked metadata; older tickets cannot reconstruct whether an old unavailable result was attempted. The feature does not fetch more H2H pages or add scan memory load.

Validation: focused tests cover labels, per-ticket counts, verified/failed/unattempted fixtures and website script syntax. The complete non-browser suite passes 524 tests. No real tickets were booked or Telegram messages sent.

## Visible compliance marks

- Red left border and “H2H CONFLICT”: the existing checker rejected the evidence, or a supported comparable historical mean opposes the total selection. The ticket shows the mean and selected line, for example 15.11 corners versus Under 12.5. The mean is a descriptive comparison, not proof of a future loss.
- Amber left border and “H2H SUPPORT NOT CONFIRMED”: missing, unreadable, unchecked or insufficient comparable evidence. Such selections remain eligible under the existing model/floor rules.
- “H2H average aligns”: a comparable mean supports the selected direction in the implemented historical totals model. It is not a calibrated accuracy claim. Markets without a comparable model are not given a green compliance mark simply because a page loaded.

The ticket summary counts conflicts and selections without confirmed support. Existing exclusion rules and probability floors are unchanged: this update does not reinsert picks rejected during selection. A conflicting pick that remains eligible under its original rules (for example after a conservative probability cap and a low requested floor) is visibly marked in the ticket. Historical mean/line alignment metadata is retained with saved slip selections. Build a fresh ticket to populate it.
