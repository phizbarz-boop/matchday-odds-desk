# Analysis / H2H browser resource controls

The supplied log shows a fresh Node start and reset upstream counters during analysis. It does not contain the termination cause; memory pressure, a deployment, a host restart or another failure cannot be distinguished from that excerpt alone. The analysis-worker message is now phrased as “no longer responding” because an expired lease alone does not prove that the entire server stopped.

This update reduces H2H browser resource overlap:
- One browser context is used across simultaneous website and Telegram H2H batches, rather than two contexts per batch.
- Chromium is closed when the last H2H batch is idle; a disconnected browser is discarded before the next launch.
- Before launching Chromium, the app reads the host's cgroup memory limit and usage when available. If less than 192 MiB is free, it declines that launch and reports host_memory_pressure. This is a conservative guard, not a guarantee that all launches fit within a host's limit. On hosts without readable cgroup limits, it makes no inferred free-memory claim.
- Missing browser dependencies or low host memory stop repeated failing attempts within that batch. Remaining fixtures are explicitly not checked, with the same explanation. They remain eligible using the original model, as requested.
- Successful H2H snapshots prune expired entries and retain at most 200 recent fixture records.

The existing H2H scheduling budget is unchanged. With one context, fewer fixtures may be checked within it. The app does not label skipped H2H evidence as verified or change probability floors to hide a failure.

Render logs now include `[Runtime memory] startup` and `[Runtime memory] H2H browser start` with Node RSS, heap usage/limit and available host memory when readable. If the service still restarts, the termination lines immediately before the next npm start and these readings are required to diagnose the actual remaining cause. These changes do not claim to prevent a host restart or deployment.

Validation: 536 non-browser tests pass, including serialized contexts, browser cleanup/relaunch, low-memory refusal and cgroup parsing. Actual Render peak memory and public H2H success still require deployment verification. No real booking, Telegram send or deployment was performed.
