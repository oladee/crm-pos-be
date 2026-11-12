import { type Job, type Queue, UnrecoverableError } from 'bullmq';
import { type Connection, type Model, Types } from 'mongoose';
import type { CheckoutService } from '../pos/checkout.service';
import { eventLog } from './event-jobs';
import { isEventId } from './event-outbox';

export const paymentReconciliationQueue = 'payment-reconciliation-v1';
const webhookJob = 'payment.webhook.received.v1';
const checkJob = 'payment.status.check.v1';
const pendingAttempts = ['queued', 'pending', 'unknown', 'review'];
const pageSize = 100;
const lookAheadMs = 15_000;
type PaymentKind = typeof webhookJob | typeof checkJob;
export type PaymentJob = { recordId: string };
type Schedule = { _id: Types.ObjectId; next_check?: Date; lease_until?: Date };

function records(db: Connection, kind: PaymentKind): Model<any> {
  return db.model(
    kind === webhookJob ? 'PosWebhookInbox' : 'PosPaymentAttempt',
  ) as unknown as Model<any>;
}

function pending(kind: PaymentKind) {
  return kind === webhookJob
    ? { state: 'pending' }
    : { status: { $in: pendingAttempts } };
}

function dueAt(row: Schedule) {
  return Math.max(
    row.next_check?.getTime() ?? 0,
    row.lease_until?.getTime() ?? 0,
  );
}

function paymentJobId(kind: PaymentKind, row: Schedule) {
  return `${kind}-${row._id}-${dueAt(row)}`;
}

export class PaymentReconciliationRelay {
  private readonly cursors = new Map<PaymentKind, Types.ObjectId>();

  constructor(
    private readonly db: Connection,
    private readonly queue: Queue<PaymentJob>,
  ) {}

  async dispatch() {
    for (const kind of [webhookJob, checkJob] as const) {
      const now = Date.now();
      const horizon = new Date(now + lookAheadMs);
      const cursor = this.cursors.get(kind);
      const rows = await records(this.db, kind)
        .find({
          ...pending(kind),
          ...(cursor ? { _id: { $gt: cursor } } : {}),
          $and: [
            {
              $or: [{ lease_until: null }, { lease_until: { $lte: horizon } }],
            },
            ...(kind === checkJob
              ? [
                  {
                    $or: [
                      { next_check: null },
                      { next_check: { $lte: horizon } },
                    ],
                  },
                ]
              : []),
          ],
        })
        .select('_id next_check lease_until')
        .sort({ _id: 1 })
        .limit(pageSize)
        .lean();

      if (rows.length) {
        const jobs = rows.map((row) => ({
          name: kind,
          data: { recordId: String(row._id) },
          opts: {
            jobId: paymentJobId(kind, row),
            delay: Math.max(0, dueAt(row) - Date.now()),
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            // Mongo records remain pending if a worker exhausts Redis retries.
            // Removing the failed job lets the relay reconstruct it.
            removeOnFail: true,
          },
        }));
        await this.queue.addBulk(jobs);
        eventLog('debug', 'payment_reconciliation_dispatched', {
          queue: paymentReconciliationQueue,
          type: kind,
          count: jobs.length,
        });
      }
      if (rows.length === pageSize) this.cursors.set(kind, rows.at(-1)!._id);
      else this.cursors.delete(kind);
    }
  }
}

export async function reconcilePaymentJob(
  db: Connection,
  service: CheckoutService,
  job: Job<PaymentJob>,
) {
  const { recordId } = job.data ?? {};
  const kind = job.name;
  if (
    !isLocationId(recordId) ||
    (kind !== webhookJob && kind !== checkJob) ||
    !job.id?.startsWith(`${kind}-${recordId}-`) ||
    !safePaymentJobId(job.id)
  ) {
    throw new UnrecoverableError('invalid_payment_reconciliation_job');
  }

  const trace: Parameters<typeof eventLog>[2] = {
    queue: paymentReconciliationQueue,
    type: kind,
    jobId: job.id,
    attempt: job.attemptsMade + 1,
    correlationId: recordId,
    ...(kind === webhookJob ? { inboxId: recordId } : { attemptId: recordId }),
  };
  try {
    const row = await records(db, kind)
      .findOne({ _id: recordId, ...pending(kind) })
      .select(
        '_id checkout hub provider correlation_id next_check lease_until status',
      )
      .lean();
    if (!row || job.id !== paymentJobId(kind, row) || dueAt(row) > Date.now()) {
      eventLog('debug', 'payment_reconciliation_stale', trace);
      return;
    }
    if (kind === webhookJob && isEventId(row.correlation_id))
      trace.correlationId = row.correlation_id;
    if (row.provider === 'moniepoint' || row.provider === 'squad')
      trace.provider = row.provider;
    if (kind === checkJob) {
      const checkout = (await db
        .model('PosCheckout')
        .findById(row.checkout)
        .select('hub')
        .lean()) as { hub?: Types.ObjectId } | null;
      trace.checkoutId = isLocationId(String(row.checkout))
        ? String(row.checkout)
        : undefined;
      trace.hubId = checkout?.hub ? String(checkout.hub) : undefined;
    } else if (row.hub) {
      trace.hubId = String(row.hub);
    }
    eventLog('debug', 'payment_reconciliation_processing', trace);
    const outcome =
      kind === webhookJob
        ? await service.processInbox(row, trace.correlationId)
        : await service.poll(row, trace.correlationId);
    if (outcome === 'deferred') {
      eventLog('warn', 'payment_reconciliation_deferred', {
        ...trace,
        code: 'retry_from_mongo',
      });
    } else {
      eventLog(
        outcome === 'stale' || outcome === 'empty' ? 'debug' : 'info',
        `payment_reconciliation_${outcome}`,
        trace,
      );
    }
  } catch {
    eventLog('warn', 'payment_reconciliation_failed', {
      ...trace,
      code: 'reconciliation_error',
    });
    throw new Error('reconciliation_error');
  }
}

function isLocationId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

export function safePaymentJobId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^payment\.(?:webhook\.received|status\.check)\.v1-[a-f\d]{24}-\d{1,16}$/i.test(
      value,
    )
  );
}
