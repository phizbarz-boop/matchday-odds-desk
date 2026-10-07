#!/usr/bin/env python3
"""Submit one Telegram batch, then poll it without submitting another batch."""
import argparse
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", choices=["daily-picks", "next-12h-picks"], default="daily-picks")
    args = parser.parse_args()
    secret = os.environ.get("TELEGRAM_JOB_SECRET", "")
    base = os.environ.get("MATCHDAY_BASE_URL", "https://matchday-odds-desk.onrender.com").rstrip("/")
    run_id = os.environ.get("MATCHDAY_RUN_ID") or os.environ.get("GITHUB_RUN_ID", "")
    event = os.environ.get("GH_EVENT_NAME") or os.environ.get("GITHUB_EVENT_NAME", "workflow_dispatch")
    mode = "scheduled" if args.endpoint == "daily-picks" and event == "schedule" else "manual"
    if not secret:
        print("Missing GitHub secret TELEGRAM_JOB_SECRET", file=sys.stderr)
        return 1
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,160}", run_id):
        print("A valid GITHUB_RUN_ID or MATCHDAY_RUN_ID is required", file=sys.stderr)
        return 1
    try:
        timeout = float(os.environ.get("TELEGRAM_REQUEST_TIMEOUT_SECONDS", "25"))
        poll_seconds = float(os.environ.get("TELEGRAM_POLL_SECONDS", "3"))
        max_wait = float(os.environ.get("TELEGRAM_POLL_MAX_SECONDS", "1800"))
        if min(timeout, poll_seconds, max_wait) <= 0:
            raise ValueError()
    except ValueError:
        print("Telegram request/poll time settings must be positive numbers", file=sys.stderr)
        return 1
    endpoint = base + "/api/telegram/" + args.endpoint
    status_url = endpoint + "/run-status/" + run_id
    headers = {"x-telegram-job-secret": secret, "Accept": "application/json"}

    def request(url, method="GET"):
        extra = {"Content-Type": "application/json", "Prefer": "respond-async",
                 "x-matchday-run-mode": mode, "x-matchday-run-id": run_id} if method == "POST" else {}
        req = urllib.request.Request(url, data=b"{}" if method == "POST" else None,
                                     headers={**headers, **extra}, method=method)
        # Do not forward the job secret to a redirect destination.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None
        opener = urllib.request.build_opener(NoRedirect)
        try:
            response = opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError):
            return 0, {"error": "HTTP connection failed or timed out"}
        try:
            with response:
                code = response.code
                raw = response.read(1024 * 1024).decode("utf-8", errors="replace")
            try:
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise ValueError()
            except ValueError:
                payload = {"error": "The server returned an empty or non-JSON response",
                           "responsePreview": raw[:500]}
            return code, payload
        except (TimeoutError, socket.timeout, OSError):
            return 0, {"error": "HTTP response was lost before it could be confirmed"}

    def show(code, payload):
        # Server outcomes only; never print request headers or the bot/job tokens.
        print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
        print("HTTP_STATUS:" + str(code), flush=True)

    def finish(code, payload):
        show(code, payload)
        if 200 <= code < 300 and not payload.get("retryable") and payload.get("ok") is not False:
            if payload.get("reason") == "no_eligible_safe_games":
                print("No SAFE ticket qualified at 85% and odds 1.30–5.00; the app reported this to Telegram.", flush=True)
            return 0
        return 22

    print(f"Telegram run type: {mode}; run ID: {run_id}; batch: {args.endpoint}", flush=True)
    code, payload = request(endpoint, "POST")
    if code != 202 and (200 <= code < 300 or payload.get("runRequestStatus") == "failed"):
        return finish(code, payload)
    if code not in (0, 202, 500, 502, 503, 504) or payload.get("code") in {
        "TELEGRAM_CONFIG_MISSING", "TELEGRAM_REDIS_REQUIRED", "TELEGRAM_RUN_ID_REQUIRED",
        "TELEGRAM_RUN_CONFLICT", "TELEGRAM_RUN_QUEUE_BUSY"
    }:
        return finish(code, payload)
    if code != 202:
        show(code, payload)
        print("Checking the same run ID after an unconfirmed submission; no second POST will be sent.", flush=True)

    deadline = time.monotonic() + max_wait
    last_stage = None
    while time.monotonic() < deadline:
        code, payload = request(status_url)
        if code == 202:
            stage = payload.get("stage", "pending")
            if stage != last_stage:
                print(f"Telegram run {run_id}: {stage}", flush=True)
                last_stage = stage
        elif payload.get("runRequestStatus") in {"completed", "failed", "unknown"} or 200 <= code < 300:
            return finish(code, payload)
        elif code not in (0, 429, 500, 502, 503, 504):
            show(code, payload)
            print("No confirmed queued result is available. Deploy the updated app and check this run before starting another batch.", file=sys.stderr)
            return 22
        else:
            print(f"Telegram status check temporarily unavailable (HTTP {code}); continuing with the same run ID.", flush=True)
        time.sleep(min(poll_seconds, max(0, deadline - time.monotonic())))
    print(f"Telegram run {run_id} has not confirmed its result. It was not submitted again. "
          f"Check {status_url} using the job secret.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
