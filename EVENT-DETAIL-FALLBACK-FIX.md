Telegram event-detail outage fix

The reported manual test reached building_manual_test_tickets, so the new manual-run routing worked. The batch then failed before booking because validatePublicSelections depended on event-detail lookup for every selected event. SportyBet returned 404 for all candidate detail paths and enabled its endpoint-resolution cooldown. That single failure propagated across the 13 plans.

Fresh validation now recovers from missing detail routes (404, unknown endpoint, or non-JSON route response) by reading current public prematch pages once per affected sport within each validation call, including requested market IDs. Pages are scanned until selected events are found or the bounded pagination ends. Exact event/market/outcome/specifier matching and model recalculation are retained. Current kickoff, live status, banned state and offered market outcomes are used. Missing or unmodelled selections are dropped, so the existing partial-ticket/top-up behavior can continue. No saved odds are accepted as evidence of current availability. Geo blocks, rate limits and other read failures remain visible; the code does not evade them or lower the 70% floor.

This does not identify a new working SportyBet detail URL. Special markets not present in fresh public pages still need the working event-detail endpoint to be validated. The app will not fabricate them. Source availability on the deployed Render server still needs confirmation after deployment.

Manual tests, 50-selection limits, seven-day long shots, tomorrow top-ups, Today’s Codes and the removed 3-hour schedule are preserved. No real booking or Telegram message was submitted for verification.
