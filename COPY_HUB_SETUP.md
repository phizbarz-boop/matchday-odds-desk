# Sporty Copy Hub — Safe Setup

The Copy Hub is installed **disabled by default**. It does not log in to X or SportyBet user accounts and it never places bets. It only reads public X posts through the official X API, validates booking codes through the project's existing SportyBet `getBooking()` adapter, stores leaderboard records separately, and later checks settlement status.

## 1. Render environment variables

Set these on the Render service:

```text
COPY_HUB_ENABLED=false
COPY_HUB_SECRET=<generate-a-long-random-secret>
REDIS_URL=<existing Redis URL>
X_BEARER_TOKEN=<X developer app bearer token>
COPY_HUB_RANKING_DAYS=30
X_COPY_MAX_RESULTS=25
X_COPY_MAX_VALIDATIONS=8
COPY_HUB_MAX_SETTLEMENT_CHECKS=20
COPY_HUB_MAX_ENTRIES=3000
```

Optional query override:

```text
X_COPY_QUERY=(SportyBet OR "SportyBet code" OR "Sporty code") -is:retweet
```

Keep `COPY_HUB_ENABLED=false` until Redis, the secret, and X credentials are set. Then switch it to `true`.

## 2. Why Redis matters

Without Redis, Copy Hub falls back to in-memory storage for local development. Render restarts would erase that memory. Production rankings should use Redis.

## 3. Protected collector endpoints

All write/collector actions require this header:

```text
x-copy-hub-secret: <COPY_HUB_SECRET>
```

Public users cannot trigger X scans, import codes, or force settlement checks.

### Scan recent public X posts

```bash
curl -X POST "https://matchday-odds-desk.onrender.com/api/copy/x/scan" \
  -H "Content-Type: application/json" \
  -H "x-copy-hub-secret: $COPY_HUB_SECRET" \
  --data '{"maxResults":25}'
```

### Check pending code settlements

```bash
curl -X POST "https://matchday-odds-desk.onrender.com/api/copy/check-settlements" \
  -H "Content-Type: application/json" \
  -H "x-copy-hub-secret: $COPY_HUB_SECRET" \
  --data '{"maxChecks":20}'
```

### Seed a known public tipster/code manually

```bash
curl -X POST "https://matchday-odds-desk.onrender.com/api/copy/import-code" \
  -H "Content-Type: application/json" \
  -H "x-copy-hub-secret: $COPY_HUB_SECRET" \
  --data '{
    "source":"x",
    "username":"ExamplePunter",
    "bookingCode":"ABC123",
    "sourceUrl":"https://x.com/ExamplePunter/status/123",
    "publishedAt":"2026-09-06T12:00:00Z"
  }'
```

## 4. Public endpoints

```text
GET /api/copy/status
GET /api/copy/leaderboard?days=30&source=all&limit=30
GET /api/copy/punter/:id?days=90
```

## 5. Ranking protections

- Uses a standardized 1-unit stake model; it does **not** claim access to a punter's real SportyBet earnings.
- A conservative Bayesian win-rate component reduces one-win leaderboard manipulation.
- Codes are de-duplicated per punter.
- Global booking-code ownership is enforced: the earliest verified public publisher is marked `ORIGINAL`; later accounts sharing the same code are marked `REPOST` and receive no win-rate, ROI, or Copy Score credit.
- Existing stored records are reconciled automatically, so discovering an earlier verified publisher later can reassign ownership without wiping Redis.
- Settlement checks are performed once per unique booking code and the result is mirrored to all observed copies, reducing duplicate SportyBet/Parse API usage.
- X source posts are de-duplicated by post ID.
- If the booking payload provides kickoff times, a code is ranking-eligible only when Matchday itself captured it before the earliest kickoff. The X post timestamp alone is not trusted because posts can be edited.
- X scan validation attempts are capped with `X_COPY_MAX_VALIDATIONS` to control SportyBet parser/API-credit usage.
- X credentials and the Copy Hub secret stay server-side and never appear in `public/index.html`.

## 6. Recommended rollout

1. Deploy with `COPY_HUB_ENABLED=false` and confirm the rest of Matchday still works.
2. Configure Redis and `COPY_HUB_SECRET`.
3. Add `X_BEARER_TOKEN` from an X developer App.
4. Set `COPY_HUB_ENABLED=true`.
5. Manually run one X scan and inspect the leaderboard.
6. Start with 5–8 validation attempts per scan until you know the Parse/SportyBet credit usage.
7. Only after observing stable results, add a scheduled GitHub Action for X scans and settlement checks.

The Auto Builder, fixture refresh, analyzer, booking generation, and Telegram automation do not depend on Copy Hub and continue to work if Copy Hub is disabled or an X request fails.
