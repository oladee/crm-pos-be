# Event relay and worker

The POS backend owns the shared `event_outbox` collection for the initial
diagnostic event. The existing API has no Redis dependency at startup. The
relay and worker use the same MongoDB connection selection as the POS API.
Use a MongoDB replica set, Node.js 22 or later, and separate Redis instances
for production and non-production. Use persistent Redis with `noeviction`.
Restrict access to Redis and use `rediss://` with managed credentials where
available.

Build with `pnpm build`, then run these as separate processes:

- `pnpm events:relay` polls MongoDB for due events and dispatches them to BullMQ.
- `pnpm events:worker` consumes the queue and records the diagnostic result.
- `pnpm events:smoke <hub-id>` saves a diagnostic for an existing hub or RSP. Check
  for `event_persisted`, `event_dispatched`, and `event_completed` using the
  correlation ID in the first log line.
- `pnpm events:replay <hub-id> <event-id>` retries a failed event for that exact
  location. It atomically advances the event generation. A stale job from an
  older generation cannot complete a replay.

Smoke and replay commands are for operators with access to the selected
environment and its database credentials. The CLI does not grant application
roles or provide a user-facing replay endpoint. Use a staging hub or RSP for
verification.

A publisher must write the outbox row using the same MongoDB transaction
and session as its business mutation. The event and correlation IDs are
UUIDs. The relay sends only the event ID and generation to Redis. The worker
loads the current record from MongoDB and fences its completion by status,
generation, and originating location. Each new job type must put its business
effect and its completion marker in one MongoDB transaction or use a durable
idempotency key at the destination.

After a dispatch attempt, the relay revisits an unfinished event after ten
seconds. A relay or Redis outage leaves the event in MongoDB. When Redis
returns, missing jobs are re-created. BullMQ retries transient processing
errors up to five attempts. Once the relay observes a failed job, it records
the failure and a generation-specific cleanup marker in MongoDB before
removing the Redis job. The relay retries cleanup across restarts and replays.
Alert on failed events
and prolonged pending events. Keep MongoDB outbox records for replay and
diagnostics under the application retention policy.

Set `EVENT_LOG_LEVEL=debug` to show processing and stale delivery decisions.
Errors use stable codes and job references so database and Redis exception
contents cannot expose credentials or provider data.

## Local integration check

Set `EVENT_TEST_REDIS_BINARY` to a local `redis-server` executable and optionally
set `MONGOMS_SYSTEM_BINARY` to a compatible `mongod` executable. After the build,
run `node --test test/event-infrastructure.cjs`. The test starts a disposable
MongoDB replica set and a Redis server bound to a random localhost port.
