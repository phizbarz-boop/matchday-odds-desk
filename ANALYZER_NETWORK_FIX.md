# Analyzer Network Error Fix

This build reduces analyzer upstream fan-out.

When a SportyBet booking identifies itself as football, basketball, or hockey, the analyzer now loads only that sport's candidate universe instead of fetching all supported sports over the 7/14/21-day horizon. This reduces simultaneous SportyBet/Parse requests and lowers the chance that Render closes a long-running request.

The browser analyzer also handles non-JSON HTTP errors and gives a clearer message when the connection itself is interrupted.

If a booking does not identify its sport, the analyzer deliberately falls back to `all` so matching accuracy is not silently reduced.
