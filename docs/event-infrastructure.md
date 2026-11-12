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

## Payment reconciliation

The standard checkout keeps verified webhooks in `pos_webhook_inbox` and
payment check schedules in `pos_payment_attempts`. The payment relay rebuilds
BullMQ jobs from these collections and schedules status checks up to 15 seconds
ahead. Redis jobs contain only the Mongo record ID. The worker rechecks the
stored schedule and claims the Mongo lease before processing. A leased record
becomes eligible again after its lease expires, including after a worker crash.
The provider transaction and checkout guards still govern financial changes.

The API defaults to `POS_PAYMENT_RECONCILIATION_MODE=legacy`. To cut over:

1. Deploy the new code to every API replica with the default mode. Prepare
   separate `pnpm payments:relay` and `pnpm payments:worker` services with the
   same MongoDB and provider configuration as the API, plus `EVENT_REDIS_URL`.
2. Move every API replica to `POS_PAYMENT_RECONCILIATION_MODE=bullmq` and confirm
   old replicas have drained before starting the relay and worker in BullMQ mode.
   Webhooks remain durable during the gap. In BullMQ mode, the checkout refresh
   endpoint reads current state while the worker owns provider status checks.
3. Check an accepted webhook audit record's exchange ID against the worker
   correlation ID. Check due work and provider audit rows before scaling workers.
   The same status reconciliation also recovers queued attempts abandoned before
   their synchronous initial dispatch began.
4. To roll back, stop the payment worker and relay before restoring API replicas
   to `legacy`. Existing Mongo leases expire naturally. Keep
   `POS_PAYMENT_WORKER_ENABLED=true` on whichever reconciliation path is active.

Existing checkout settlement, provider credentials, legacy Squad transfers,
and explicit manual payment confirmation continue through their existing handlers.

## Live tills and notifications

After deploying the CRM ticket route and the POS gateway, enable
`POS_LIVE_ENABLED=true` on POS API and payment worker processes. Configure
`POS_LIVE_CRM_ORIGINS` and `POS_FE_ORIGIN` with exact browser origins. Point the
CRM API's `POS_LIVE_URL` at `wss://<pos-api>/pos/live` and enable
`NEXT_PUBLIC_POS_LIVE_ENABLED=true` for the till frontend build.
Run the event relay and worker so notifications publish across API replicas.
All participating processes must use the same CRM/POS MongoDB and event Redis
for their environment.

The CRM endpoint creates a 30-second one-use socket ticket after checking the
session. It grants dashboard access only to users with `view_pos` and the
locations they can read, including permitted child RSPs. Till authentication
uses the current PIN session and active assignment. Credentials travel in the
first WebSocket frame, outside URLs. The gateway refreshes authentication after
five minutes. Heartbeats run every 15 seconds and dashboard presence expires
after 45 seconds. The CRM refreshes the authoritative snapshot every 30 seconds,
including shift or payment changes made while a till is offline. Only coarse
activity transitions are retained.

Notices are saved together with an outbox record in the source transaction.
The Redis broadcast contains the notice ID and MongoDB holds the audience and
display fields. Reconnecting clients fetch their most recent 50 eligible
notices. The three recipient types are:

- `till` uses the originating checkout's `hubId` and `tillId`.
- `location-role` uses the review's `hubId` and the `pos-admin` role.
- `user` uses the authenticated account's exact MongoDB ID. Import or export
  completion producers can persist `kind: personal` with their saved
  requester ID and an operation-specific source key.

Keep source keys stable for retries. Store a notice in `pos_live_notices` and
its `notification.ready.v1` outbox event with `noticeId` in the same source
transaction. Payment confirmation tones require an explicit browser gesture.
The till uses a shared IndexedDB claim to play each live notice once across
tabs. Recovered notices appear in the notification list silently.
The till restores its existing receipt polling notices when the Redis
subscription drops or heartbeat acknowledgements stop. Visual notices remain
available when the browser denies access to notification storage.
