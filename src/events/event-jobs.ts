import { type Job, type Queue, UnrecoverableError } from 'bullmq';
import {
  diagnosticEvent,
  eventQueue,
  isEventId,
  type EventOutbox,
} from './event-outbox';

export type EventJob = { eventId: string; generation: number };
type Trace = {
  queue?: string;
  eventId?: string;
  hubId?: string;
  correlationId?: string;
  jobId?: string;
  attempt?: number;
  generation?: number;
  type?: string;
  provider?: string;
  checkoutId?: string;
  inboxId?: string;
  attemptId?: string;
  count?: number;
  code?: string;
};

export function eventLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  action: string,
  trace: Trace = {},
) {
  if (level === 'debug' && process.env.EVENT_LOG_LEVEL !== 'debug') return;
  const line = JSON.stringify({ level, action, queue: eventQueue, ...trace });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export async function dispatchEvent(
  outbox: EventOutbox,
  queue: Queue<EventJob>,
  isRedisReady: () => boolean,
) {
  const now = new Date();
  // The scheduling timestamp is also the lease. A stopped relay leaves a row
  // eligible for another relay once the lease expires.
  const event = await outbox
    .findOneAndUpdate(
      { status: 'pending', nextDispatchAt: { $lte: now } },
      { $set: { nextDispatchAt: new Date(now.getTime() + 10_000) } },
      { sort: { nextDispatchAt: 1 }, returnDocument: 'after' },
    )
    .lean();
  if (!event) return false;

  const { eventId, correlationId, generation, type } = event;
  const hubId = event.hubId.toString();
  const jobId = `${eventId}-${generation}`;
  const trace = { eventId, correlationId, generation, hubId, jobId, type };
  try {
    if (!isRedisReady()) throw new Error('redis_unavailable');
    const job = await queue.getJob(jobId);
    const state = await job?.getState();
    if (state === 'failed') {
      const result = await outbox.updateOne(
        { eventId, hubId, generation, status: 'pending' },
        {
          $set: { status: 'failed', failedAt: new Date(), nextCleanupAt: now },
          $addToSet: { cleanupGenerations: generation },
          $unset: { nextDispatchAt: 1 },
        },
      );
      if (result.modifiedCount) {
        eventLog('error', 'event_retries_exhausted', {
          ...trace,
          attempt: job?.attemptsMade,
          code: 'job_failed',
        });
      }
    } else if (!job) {
      await queue.add(
        type,
        { eventId, generation },
        {
          jobId,
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          // The relay reconciles exhausted jobs into Mongo before removing them.
          removeOnFail: false,
        },
      );
      eventLog('info', 'event_dispatched', trace);
    }
  } catch {
    eventLog('warn', 'event_dispatch_retry_scheduled', {
      ...trace,
      code: 'dispatch_error',
    });
  }
  return true;
}

export async function cleanupFailedEventJob(
  outbox: EventOutbox,
  queue: Queue<EventJob>,
  isRedisReady: () => boolean,
) {
  if (!isRedisReady()) return false;
  const now = new Date();
  const event = await outbox
    .findOneAndUpdate(
      {
        nextCleanupAt: { $lte: now },
        'cleanupGenerations.0': { $exists: true },
      },
      { $set: { nextCleanupAt: new Date(now.getTime() + 10_000) } },
      { sort: { nextCleanupAt: 1 }, returnDocument: 'after' },
    )
    .lean();
  const generation = event?.cleanupGenerations?.[0];
  if (!event || generation == null) return false;
  const jobId = `${event.eventId}-${generation}`;
  const trace = {
    eventId: event.eventId,
    hubId: event.hubId.toString(),
    correlationId: event.correlationId,
    generation,
    jobId,
  };
  try {
    const job = await queue.getJob(jobId);
    if (job) await job.remove();
    const cleared = await outbox.updateOne(
      { _id: event._id, cleanupGenerations: [generation] },
      { $unset: { nextCleanupAt: 1, cleanupGenerations: 1 } },
    );
    if (!cleared.modifiedCount) {
      await outbox.updateOne(
        { _id: event._id },
        { $pull: { cleanupGenerations: generation } },
      );
    }
    eventLog('debug', 'event_failed_job_removed', trace);
  } catch {
    eventLog('warn', 'event_job_cleanup_retry_scheduled', {
      ...trace,
      code: 'cleanup_error',
    });
  }
  return true;
}

export async function processEvent(outbox: EventOutbox, job: Job<EventJob>) {
  const { eventId, generation } = job.data ?? {};
  if (
    !isEventId(eventId) ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    job.id !== `${eventId}-${generation}` ||
    job.name !== diagnosticEvent
  ) {
    throw new UnrecoverableError('invalid_event_job');
  }

  const trace: Trace = {
    eventId,
    generation,
    type: job.name,
    jobId: job.id,
    attempt: job.attemptsMade + 1,
  };
  let failureCode = 'event_lookup_error';
  try {
    const event = await outbox
      .findOne({ eventId, generation, type: job.name, status: 'pending' })
      .lean();
    if (!event) {
      eventLog('debug', 'event_duplicate_or_stale', trace);
      return;
    }
    trace.hubId = event.hubId.toString();
    trace.correlationId = event.correlationId;
    eventLog('debug', 'event_processing', trace);
    failureCode = 'event_commit_error';
    // The diagnostic has no external side effect. Its conditional completion
    // is the result, so a repeat delivery cannot apply the result twice.
    const result = await outbox.updateOne(
      { eventId, hubId: event.hubId, generation, status: 'pending' },
      {
        $set: { status: 'completed', completedAt: new Date() },
        $unset: { nextDispatchAt: 1 },
      },
    );
    eventLog(
      result.modifiedCount ? 'info' : 'debug',
      result.modifiedCount ? 'event_completed' : 'event_duplicate_or_stale',
      trace,
    );
  } catch {
    eventLog('warn', 'event_processing_failed', {
      ...trace,
      code: failureCode,
    });
    throw new Error(failureCode);
  }
}
