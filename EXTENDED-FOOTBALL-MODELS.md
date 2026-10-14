# Extended football settlement models

Full-regulation match and team totals on confirmed SportyBet IDs 18/19/20: integer, half and quarter lines. Asian handicaps on confirmed ID 16: positive/negative integer, half and quarter lines. Quarter lines split the stake across adjacent half-lines. Full win, push, half win/loss and loss are separate. Threshold probability for these new candidates is full-win probability, not push-inclusive or fair-price-equivalent probability. EV uses the full settlement distribution.

1UP (60200) and 2UP (60100) use independent constant-rate Poisson goal paths: selected team reaches the required lead during regulation or wins at full time. Draw selections use ordinary final draw probability. Goal ordering is integrated with a reflection-principle calculation, verified against exhaustive short paths. Result tracking requires official early-payout settlement rather than inferring a loss from a final score after a possible earlier lead.

Priority input: existing SportyBet displayed-statistics goal lambdas. If absent, fit the two scoring rates to complete ordinary 1X2 and full-match half-line total prices with margin removal. Inconsistent markets, incomplete boards, live states, unknown periods and unsupported promo IDs remain excluded. Price-fitted estimates are explicitly market-derived and are not independent value signals. Existing supported candidates keep priority.

Both analyzer paths, the auto-builder expanded-market option and public fresh validation use the same model layer. Exact market/outcome/line IDs and original ticket labels are preserved. No replacement by a different bet type is used to manufacture coverage.

Predictive accuracy is NOT empirically validated. Passing settlement and numerical tests establishes implementation correctness under model assumptions, not real-world calibration or winning guarantees. Poisson assumptions omit time-varying scoring, red-card effects and score-dependent tactics. Some SportyBet markets remain unmodeled. Quality/rank fields do not represent measured forecast accuracy.

Read-only live-board check: NS4RF9 first event full public markets supplied a coherent fit and the exact Over 2 selection had separate win/refund/loss estimates. No stake, booking or Telegram send was submitted while checking.
