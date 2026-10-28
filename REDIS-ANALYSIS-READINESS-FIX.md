# Analysis storage readiness and recovery

The analysis storage error means the server could not reserve a durable job in Redis before starting the scan. It does not establish whether the live service has a connection failure, incorrect configuration, outage, quota issue or other provider problem.

Fixed a shared connection race: getRedis previously returned its client while another request was still connecting. Callers now share the connection readiness promise. Disconnected clients reconnect on demand, readiness is bounded, reconnect attempts are bounded, and commands are not silently added to an offline queue. Sanitized connection errors are throttled and never include raw connection URLs or upstream messages.

Analysis storage waits allow the connection handshake time to complete. The website retries one explicitly rejected ANALYSIS_STORAGE_UNAVAILABLE submission for analysis endpoints only. Booking submissions are not retried by this recovery path. A job whose initial Redis reservation fails is still rejected before its handler starts; no memory-only fallback is introduced for configured Redis failures. Membership, saved codes and booking persistence safeguards remain.

Deploy normally. If the error continues, inspect Render logs for [Redis connection] and verify that REDIS_URL points to the active Redis service, with the provider's required TLS URL and current credentials. Check the provider dashboard for suspension or quota exhaustion. Do not clear the database or paste credentials into chat. Production Redis connectivity was not tested locally.
