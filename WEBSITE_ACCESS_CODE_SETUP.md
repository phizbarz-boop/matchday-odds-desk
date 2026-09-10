# Website Access Code

The browser UI is protected by a server-side access-code gate.

## Render environment variables

Required:

- `WEBSITE_ACCESS_CODE` — the code visitors must enter before the website loads.

Optional:

- `WEBSITE_ACCESS_SESSION_SECRET` — separate secret used to sign the access cookie. If omitted, the access code is used.
- `WEBSITE_ACCESS_MAX_AGE_SECONDS` — login duration, default 604800 seconds (7 days).

Changing `WEBSITE_ACCESS_CODE` invalidates existing access sessions.

The `/api/*` routes are intentionally not placed behind this browser gate because existing Telegram/GitHub jobs use their own endpoint secrets and must continue to run.

Users can visit `/logout` to clear the website access cookie.
