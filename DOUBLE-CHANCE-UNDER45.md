# Double chance and Under 4.5 combo markets

Added two prematch football controls to the website browse tab, compact Auto Analyser grid and Telegram bot market menus:

- Home or Away & Under 4.5 (12 and fewer than five total goals).
- Double Chance & Under 4.5 (best eligible Home/Draw or Draw/Away combo).

Existing daily football short and long-shot plans can choose these markets, subject to their current probability floors. This does not add another scheduled Telegram batch or change existing dedicated Under 4.5 plans.

The exact offered market ID, outcome ID, specifier, selection description and odds are preserved. Only full-regulation Double Chance & Over/Under markets at 4.5 are decoded; mismatched lines, periods, live markets and unsupported labels are excluded. The collector reads public 1X2 fixtures and bounded event detail scans, so availability depends on actual offered markets and scan coverage.

The model sums score-matrix cells satisfying both conditions. It uses available goal-model rates or the existing complete 1X2-plus-total calibrated Poisson rates. Overlapping double-chance prices are not treated as an exhaustive probability partition, and separate leg probabilities are not multiplied. No rate inputs means no estimated candidate. Probability and edge filters remain in effect; estimates are not guaranteed or empirically calibrated accuracy claims.

H2H total-only averages are not presented as proof of the combined result and total selection. Final-score settlement checks both conditions in regulation time; an under-five-goal draw loses a Home/Away combo. Website and bot code analysis retain the exact combination identity.
