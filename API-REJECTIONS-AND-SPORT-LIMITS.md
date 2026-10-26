# API rejection diagnostics and separate sport budgets

The supplied worker log confirms APISPORTS_H2H_ENABLED=true and one hockey history_ready result. Most other API attempts returned a generic API_REQUEST_REJECTED or mapping failure and fell back to SportyBet. The excerpt does not contain the final saved/provider summary, so it cannot establish the number of API records saved to Redis.

The old rejection code intentionally omitted raw provider errors, but it also hid the information needed to distinguish quota, plan restrictions and invalid parameters. Rejections now include a controlled category, official endpoint path, sport, HTTP status and recognized error field names. Raw messages/values, keys, headers and account identity are never printed. Categories include API_PLAN_RESTRICTED, API_PARAMETERS_REJECTED, API_RATE_LIMIT and API_DAILY_QUOTA. Provider rate-limit responses suppress additional API requests in the same UTC minute; daily-quota responses stop further requests to that API for that UTC day.

Football team search no longer sends the fixture's competition country as a club-country filter. Those are not always the same: an international competition is not a country, and a club can play in another country's competition. Search still requires a unique exact normalized club identity. Multiple same-name team IDs remain rejected. This fixes that incorrect parameter assumption; the earlier generic log alone cannot prove that it caused every supplied rejection.

## Use the verified Football Pro allowance independently

The user's subscription report confirmed Football Pro with 7,500/day; basketball, hockey, handball and volleyball remain Free at 100/day. On GitHub → Settings → Secrets and variables → Actions → Variables set:

| Repository variable | Value |
| --- | --- |
| APISPORTS_H2H_ENABLED | true |
| APISPORTS_H2H_DAILY_LIMIT_FOOTBALL | 7500 |
| APISPORTS_H2H_DAILY_LIMIT | 100 |
| APISPORTS_H2H_MINUTE_LIMIT | 10 |

The football override does not raise the other APIs' daily limits. It is wired into the automatic worker workflow. The minute limit remains conservative; raising the daily limit does not override the provider's actual plan, coverage or minute allowance. Existing usage counters are preserved. Cached history and safe fallback behavior remain in place.

## Diagnose one rejected fixture

After pushing this update, start a NEW Plot207 API-Sports H2H Test run on the updated main branch with event_id=sr:match:74994258, one of the football fixtures rejected in the supplied log, while it is still cached/upcoming. The read-only test does not book, send Telegram messages or write Redis. It uses small test request limits; it does not inherit the automatic worker's expanded daily football budget.

The new output will show either verified H2H data or sanitized apiDiagnostics with the endpoint and specific rejection category. Share that report to distinguish plan/season access from parameters or rate limits. No key change is required. Do not rerun a job from the old commit.

The automatic H2H workflow continues on its existing schedule. Render keeps SPORTYBET_H2H_ENABLED=false. Tennis continues through SportyBet because this provider has no configured tennis product. Missing tabs, metrics and sample sizes remain unconfirmed rather than being converted into verified support.

Validation covers error classification without leaking provider values, safe automatic fallback logging, separate paid/free budgets and persistent suppression after upstream minute-limit responses. The actual paid-account rejection cannot be reproduced from this development environment without its private key, so this release does not claim that all provider rejections have been resolved.
