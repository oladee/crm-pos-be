import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createConnection } from 'mongoose';
import {
  eventLog,
  cleanupFailedEventJob,
  dispatchEvent,
  processEvent,
  type EventJob,
} from './event-jobs';
import {
  eventOutbox,
  eventQueue,
  parseHubId,
  publishDiagnostic,
  replayEvent,
} from './event-outbox';

async function main() {
  const [mode, hubArg, eventArg] = process.argv.slice(2);
  if (!['relay', 'worker', 'smoke', 'replay'].includes(mode))
    throw new Error('invalid_event_mode');
  const mongo =
    process.env.NODE_ENV === 'dev'
      ? process.env.MONGO_STRING_TEST
      : process.env.MONGO_STRING_PROD;
  if (!mongo) throw new Error('event_mongo_uri_required');
  const redisUrl = process.env.EVENT_REDIS_URL;
  if ((mode === 'relay' || mode === 'worker') && !redisUrl)
    throw new Error('event_redis_url_required');

  const db = createConnection(mongo, { serverSelectionTimeoutMS: 5000 });
  const outbox = eventOutbox(db);
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await db.asPromise();
    await outbox.createIndexes();

    if (mode === 'smoke' || mode === 'replay') {
      const hubId = parseHubId(hubArg);
      if (
        !(await db
          .collection('hubs')
          .findOne({ _id: hubId }, { projection: { _id: 1 } }))
      ) {
        throw new Error('event_hub_not_found');
      }
      const event =
        mode === 'smoke'
          ? await db.transaction((session) =>
              publishDiagnostic(outbox, session, hubId),
            )
          : await replayEvent(outbox, hubId, eventArg);
      if (!event) throw new Error('event_not_replayable');
      eventLog(
        'info',
        mode === 'smoke' ? 'event_persisted' : 'event_replayed',
        {
          eventId: event.eventId,
          hubId: hubId.toString(),
          correlationId: event.correlationId,
          generation: event.generation,
          type: event.type,
        },
      );
      return;
    }

    const redis = new Redis(
      redisUrl!,
      mode === 'relay'
        ? {
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
            commandTimeout: 5000,
          }
        : { maxRetriesPerRequest: null },
    );
    redis.on('error', () =>
      eventLog('warn', 'event_redis_unavailable', { code: 'redis_error' }),
    );
    try {
      if (mode === 'relay') {
        const isRedisReady = () => redis.status === 'ready';
        const queue = new Queue<EventJob>(eventQueue, { connection: redis });
        queue.on('error', () =>
          eventLog('warn', 'event_queue_unavailable', { code: 'queue_error' }),
        );
        try {
          while (!stop.signal.aborted) {
            let dispatched = false;
            let cleaned = false;
            try {
              dispatched = await dispatchEvent(outbox, queue, isRedisReady);
              cleaned = await cleanupFailedEventJob(
                outbox,
                queue,
                isRedisReady,
              );
            } catch {
              eventLog('error', 'event_relay_read_failed', {
                code: 'outbox_error',
              });
            }
            if (!dispatched && !cleaned)
              await delay(1000, undefined, { signal: stop.signal }).catch(
                () => undefined,
              );
          }
        } finally {
          redis.disconnect();
          await queue.close();
        }
      } else {
        const worker = new Worker<EventJob>(
          eventQueue,
          (job) => processEvent(outbox, job),
          {
            connection: redis,
            concurrency: 4,
          },
        );
        worker.on('error', () =>
          eventLog('warn', 'event_worker_error', { code: 'worker_error' }),
        );
        worker.on('failed', (job) =>
          eventLog('warn', 'event_job_failed', {
            ...(isSafeJobId(job?.id) ? { jobId: job?.id } : {}),
            attempt: job?.attemptsMade,
            code: 'job_failed',
          }),
        );
        worker.on('stalled', (jobId) =>
          eventLog('warn', 'event_job_stalled', {
            ...(isSafeJobId(jobId) ? { jobId } : {}),
            code: 'job_stalled',
          }),
        );
        try {
          if (!stop.signal.aborted) {
            await new Promise<void>((resolve) =>
              stop.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
          }
        } finally {
          await worker.close(redis.status !== 'ready');
        }
      }
    } finally {
      redis.disconnect();
    }
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await db.close();
  }
}

function isSafeJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}-[0-9]+$/i.test(value);
}

void main().catch(() => {
  eventLog('error', 'event_process_failed', {
    code: 'event_startup_or_command_error',
  });
  process.exitCode = 1;
});
