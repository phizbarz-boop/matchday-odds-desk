# H2H totals must affect selection

## Corrected behavior

The previous basketball/hockey conflict guard only rejected opposing means when sampleCount was at least five. Smaller or unreported samples therefore left contradictory selections eligible. In addition, the generic overtime/distribution warning was applied to first-half and first-quarter basketball markets even when the corresponding period average was available.

Comparable historical means now act as a descriptive direction filter:

- Over: an average below the selected line is rejected.
- Under: an average above the selected line is rejected.
- An average equal to the line supplies no direction and remains unconfirmed.
- Missing, stale, wrong-fixture or non-comparable history does not manufacture support and still does not remove the selection merely because history is missing.

The conflict filter does not require a five-match sample. Small or unreported samples are recorded and shown; the filter is a user-requested rule about the observed average, not an estimate of win probability. It does not inflate the main model probability. Existing supported football probability caps remain conservative, and opposing comparable means are now excluded from automatic selection rather than merely labelled.

For basketball first-half and first-quarter totals, the selected period is resolved from the exact market description and specifier. Only half_points or quarter_points respectively may be compared. A full-game average cannot substitute for a missing period average. Named team totals cannot use the combined match mean. Full-game basketball/hockey scope uncertainty remains disclosed when it is not resolved.

## Supplied examples

| Historical average | Selection | Result |
| --- | --- | --- |
| 77.50 | Over 82.5 | Reject: average opposes selection |
| 81.00 | Over 77.5 | Average aligns |
| 89.80 | Under 76.5 | Reject: average opposes selection |
| 87.50 | Over 84.5 | Average aligns |
| 81.50 | Under 81.5 | Neutral: no directional support |
| 87.40 | Over 77.5 | Average aligns |
| 74.00 | Over 78.5 | Reject: average opposes selection |
| 72.00 | Over 75.5 | Reject: average opposes selection |

An average of 100 can align with both Over 90 and Under 110. It does not identify a unique best bet, account for the offered odds, or establish an exact probability by itself. The existing probability floors and SportyBet market availability still determine which aligned candidates can form a ticket. The app does not silently flip an imported selection into the opposite bet.

## Where it applies

The shared H2H assessment feeds website auto analysis, bot candidate analysis and Telegram automatic picks. Their existing eligibility checks exclude h2hCheck.allowed=false. Period selections with comparable aligned means now show H2H average aligns and direction filter applied, with mean, line, sample size and saved check time. Conflicts remain red when displayed; missing/non-comparable evidence stays amber.

After deploying, generate a NEW analysis. Cached H2H evidence can be used immediately; no fresh browser collection is required solely for this rule change. Existing displayed/saved tickets are not rewritten. Keep SPORTYBET_H2H_ENABLED=false on Render; GitHub remains the external collector.

Tests cover all eight supplied examples across sample sizes null, 1, 2, 4, 5 and 20; period and team scope isolation; unchanged probabilities; missing evidence; and exclusion of a conflicting high-probability leg from a Telegram automatic plan. No real bookings or Telegram sends were performed during development.
