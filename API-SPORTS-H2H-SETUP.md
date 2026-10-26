# Optional API-Sports H2H: configure, test, then enable

## Sports and limits

API-Sports has official football, basketball, hockey, handball and volleyball APIs. Its current official product list does not include tennis. Tennis continues through the existing public SportyBet H2H worker; it is not sent to an invented API endpoint.

One API key may have different subscription levels and allowances across the five APIs. Confirm each sport in the test report before buying or raising request limits. A football upgrade is not assumed to upgrade the other APIs. The integration is OFF by default; purchasing a subscription does not itself enable it in this app.

Official references:
- https://api-sports.io/
- https://www.api-football.com/documentation-v3
- https://api-sports.io/documentation/basketball/v1
- https://api-sports.io/documentation/hockey/v1
- https://api-sports.io/documentation/handball/v1
- https://api-sports.io/documentation/volleyball/v1

## Step 1: deploy and add the private key

Push this update to main using the deployment command supplied with the ZIP. Existing SportyBet automation continues while API integration is disabled.

On GitHub open repository Settings → Secrets and variables → Actions → Secrets → New repository secret:

| Secret | Value |
| --- | --- |
| APISPORTS_KEY | The API-SPORTS dashboard API key, entered privately |

Retain the existing REDIS_URL secret. The external worker uses that database and the website reads its saved history, so the API key is not needed in the browser or Render environment. Keep SPORTYBET_H2H_ENABLED=false on Render.

Do not put the key in a chat message, repository file, website form or workflow input. It is only sent in the x-apisports-key header to the fixed official API hosts. Redirects are refused. Request/error logs never print the key, request headers, provider error bodies or account email.

## Step 2: run the read-only test

Open Actions → Plot207 API-Sports H2H Test → Run workflow.

Leave event_id blank initially. The report checks plan, activation, usage and daily allowance for all five APIs. Status calls do not count toward the documented daily API quota. A provider error is shown as a sanitized code per sport; no account email or key is printed.

To check a real match, run the SAME test with an upcoming SportyBet event ID, such as sr:match:123 (replace with a real currently queued fixture). The test reads that fixture identity from Redis. If absent, generate a website analysis including that upcoming fixture to queue its identity, then test it. No booking is required.

The real-match test prints the matched API fixture ID, recorded past meetings, available averages and sample count for EACH metric. These authenticated fixture/statistics requests consume quota. The test has a local limit of 25 requests/day per API per invocation and 10/minute. It performs no Redis writes, booking or Telegram sends. It does not silently fall back to SportyBet, because the purpose is to reveal actual API coverage/errors.

Look for non-empty history, correct teams and dates, and nonzero sample counts for the markets you need. A successful status check alone does not prove match coverage or prediction accuracy. Free plans can restrict seasons or query parameters. API_FIXTURE_UNMAPPED means the exact team/time mapping could not be established; API_HISTORY_UNAVAILABLE means usable finished meetings were not returned. Do not treat either as verified history.

## Step 3: enable automatic API collection

After checking the test results, open Settings → Secrets and variables → Actions → Variables → New repository variable:

| Variable | Initial value |
| --- | --- |
| APISPORTS_H2H_ENABLED | true |
| APISPORTS_H2H_DAILY_LIMIT | 100 |
| APISPORTS_H2H_MINUTE_LIMIT | 10 |

The conservative limits apply per sport/API. Raise them only after checking the actual subscription allowance for EVERY enabled API. The upstream API still enforces its own subscription limits; these settings do not upgrade a subscription. Default football statistical enrichment retrieves up to five historical fixture-statistics responses per matchup, in addition to fixture mapping and H2H requests. That can use roughly seven requests for an uncached football pair. Cache hits reuse those responses.

The next scheduled H2H worker run automatically tries API-Sports for the five supported sports. Already fresh SportyBet records become eligible for an API upgrade; a failed API attempt has a 30-minute upgrade cooldown. Fresh API history is reused for the normal H2H cache period. Tennis and API errors/unmapped/unsupported fixtures retain SportyBet fallback.

The worker summary contains providers counts for history actually saved to Redis. A preliminary API history_ready log is not itself confirmation that the final Redis write completed. The website's next NEW analysis shows the stored provider per selection and recorded hit counts where they match the exact market/period.

## Data handling and accuracy

- Mapping requires exact normalized team names, unique fixture identity and kickoff within 90 minutes. No fuzzy team guessing is used; youth/women/reserve identifiers are retained. Different provider names may therefore require a future explicit verified mapping and currently fall back safely.
- Only finished, past meetings between the same two provider team IDs are used. Future, incomplete, duplicate and wrong-pair games are excluded. At most ten meetings contribute per fixture.
- Basketball first-half totals use Q1+Q2 for BOTH teams; first-quarter totals use Q1 for both. Missing quarter values never become zero. Regulation totals and overtime-inclusive totals remain separate.
- Hockey regulation totals use the three periods where supplied. Handball first-half totals use the first-period score. Volleyball match scores are SETS, not points; total points require complete set scores.
- Football uses regulation scores and separately fetched historical corners/shots statistics where returned. Goal kicks and scoring-order props are not fabricated from final scores.
- Metric sample counts are kept separately. Ten matches with scores do not imply ten matches with corner/shot/quarter statistics.
- If the API lacks a metric, a separately read SportyBet supplement may be retained. Assessment uses the applicable source and its own sample count, without averaging incompatible summaries.
- Historical hit frequency is descriptive. It is not substituted for a guaranteed win probability or used to inflate the original model. Existing probability floors and conservative H2H direction rules remain in place.

The implementation and tests are ready, but no authenticated live API test was possible during development because no API key was supplied. No subscription was purchased, credentials changed, production Redis written, booking generated or Telegram ticket sent by this work.
