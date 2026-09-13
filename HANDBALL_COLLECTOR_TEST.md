# Plot207 — SportyBet Handball Collector Test

This is deliberately only **Step 1** of the Handball/Volleyball integration.
It does not change the website Auto Builder, Telegram Auto Picks, booking-code
creation, or existing Football/Basketball/Ice Hockey behavior.

## What the test does

1. Uses the existing GitHub Secrets `SPORTYSOCIAL_LOGIN_ID` and `SPORTYSOCIAL_PASSWORD`.
2. Logs into the dedicated/dummy SportyBet account.
3. Opens SportyBet's Handball prematch sports surface.
4. Observes the normal JSON responses returned by SportyBet while that page loads.
5. Tries to extract up to 10 Handball fixtures and visible market/outcome structures.
6. Saves a sanitized diagnostic artifact named `sportybet-handball-discovery`.

It does **not** place a bet, enter a stake, access deposits/withdrawals, or bypass
CAPTCHA/OTP/security verification.

## How to run it

1. Upload/deploy this project to the same GitHub repository that already has:
   - `SPORTYSOCIAL_LOGIN_ID`
   - `SPORTYSOCIAL_PASSWORD`
2. Open the repository on GitHub.
3. Click **Actions**.
4. Click **Test SportyBet Handball Collector**.
5. Click **Run workflow**.
6. Open the completed run and expand **Test dummy login and discover Handball fixtures**.

### Successful first test

You should see:

```
[Handball Test] LOGIN SUCCESS
[Handball Test] Handball fixture candidates found: ...
{"n":1,"sport":"Handball","eventId":"...","home":"...","away":"..."}
...
[Handball Test] SUCCESS
```

### If it fails after LOGIN SUCCESS

That is still useful. At the bottom of the GitHub run, download the artifact:

`artifacts -> sportybet-handball-discovery`

It contains a safe screenshot and sanitized JSON/network index showing the current
Handball page structure. It does not intentionally save passwords, cookies, auth
tokens, balances, or account data.

Send the `handball-discovery.json` file back for the second adjustment.

## What comes after this passes

Only after Handball discovery works reliably do we:

1. map exact `eventId / marketId / outcomeId / specifier / odds`,
2. add Volleyball using the same collector,
3. match them to API-SPORTS fixtures,
4. run the Plot207 probability model,
5. call `book_bet`,
6. verify the returned code with `get_booking`,
7. finally enable them in automatic Telegram/website ticket generation.
