# X Copy Hub — Twice-Daily Automated Discovery

This version automatically scans X twice each day and sends qualifying SportyBet code posts through the existing Copy Hub ranking pipeline.

## Schedule

- 07:20 WAT (06:20 UTC)
- 19:20 WAT (18:20 UTC)

SportySocial remains scheduled at 07:00 and 19:00 WAT, so the two collectors do not run at the same time.

## Discovery logic

The default X scanner runs two targeted recent-search queries:

1. SportyBet / Sporty code / booking-code terms.
2. `boom` combined with betting signals such as SportyBet, booking code, odds, ticket, slip or tail.

`boom` alone is deliberately not searched because it would create large amounts of unrelated traffic.

Posts are scored before SportyBet validation. Strong signals include:

- valid-looking booking-code candidate
- SportyBet mention
- booking-code wording
- `boom`
- odds
- ticket/slip
- tail/copy wording
- landed/won/cashout wording

High-signal posts are validated first so `X_COPY_MAX_VALIDATIONS` controls Parse.bot/SportyBet credit usage.

## Required configuration

Render must already contain:

- `COPY_HUB_ENABLED=true`
- `COPY_HUB_SECRET`
- `X_BEARER_TOKEN`
- `REDIS_URL` (recommended)

GitHub Actions must contain the repository secret:

- `COPY_HUB_SECRET` — same value as Render

Optional GitHub Actions variable:

- `MATCHDAY_BASE_URL` — defaults to `https://matchday-odds-desk.onrender.com`

Recommended Render values while testing:

- `X_COPY_MAX_RESULTS=25`
- `X_COPY_MAX_VALIDATIONS=5`

Raise these only after checking X API and Parse.bot/SportyBet credit usage.

## Optional custom X queries

You can override the defaults in Render with either:

- `X_COPY_QUERY` for one query, or
- `X_COPY_QUERIES_JSON` for multiple queries, e.g. a JSON array of X recent-search query strings.

## Manual test

After deployment, go to GitHub → Actions → **X Copy Hub Discovery** → **Run workflow**.

A successful response includes fields such as:

- `queries`
- `uniquePostsReturned`
- `candidatePosts`
- `validations`
- `added`
- `originalsAdded`
- `repostsAdded`
- `duplicates`
- `invalid`

Only valid SportyBet codes enter the performance system. Global ORIGINAL/REPOST ownership still applies, so later reposters do not receive ranking credit for another punter's code.

## High-confidence booking-code filter

The X collector filters candidates before calling Parse.bot. Generic English words after phrases such as `code from`, `code ready`, and `code here` are not treated as booking codes. Loose BOOM discovery requires a mixed alpha-numeric token; numeric-only candidates are accepted only from stronger explicit/URL-style code contexts. This reduces wasted validation credits while preserving SportyBet share URLs and normal codes such as `RY16XF`, `4C6QCU`, `SAV9HY`, and `QTGF6F`.
