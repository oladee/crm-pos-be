import { setTimeout as delay } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Connection } from 'mongoose';
import { AppModule } from '../app.module';
import { bullmqReconciliationEnabled } from '../pos/checkout-config';
import { CheckoutService } from '../pos/checkout.service';
import { eventLog } from './event-jobs';
import {
  PaymentReconciliationRelay,
  paymentReconciliationQueue,
  reconcilePaymentJob,
  safePaymentJobId,
  type PaymentJob,
} from './payment-reconciliation';

const queue = paymentReconciliationQueue;

async function main() {
  const mode = process.argv[2];
  if (mode !== 'relay' && mode !== 'worker') throw new Error('invalid_mode');
  if (
    !bullmqReconciliationEnabled() ||
    process.env.POS_PAYMENT_WORKER_ENABLED === 'false'
  ) {
    eventLog('info', 'payment_reconciliation_disabled', { queue });
    return;
  }
  const url = process.env.EVENT_REDIS_URL;
  if (!url) throw new Error('redis_url_required');

  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  const redis = new Redis(
    url,
    mode === 'relay'
      ? {
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          commandTimeout: 5000,
        }
      : { maxRetriesPerRequest: null },
  );
  redis.on('error', () =>
    eventLog('warn', 'payment_redis_unavailable', {
      queue,
      code: 'redis_error',
    }),
  );
  try {
    const db = app.get<Connection>(getConnectionToken());
    if (mode === 'relay') {
      const jobs = new Queue<PaymentJob>(queue, { connection: redis });
      jobs.on('error', () =>
        eventLog('warn', 'payment_queue_unavailable', {
          queue,
          code: 'queue_error',
        }),
      );
      const relay = new PaymentReconciliationRelay(db, jobs);
      try {
        while (!stop.signal.aborted) {
          if (redis.status === 'ready') {
            try {
              await relay.dispatch();
            } catch {
              eventLog('warn', 'payment_reconciliation_dispatch_retry', {
                queue,
                code: 'dispatch_error',
              });
            }
          }
          await delay(1000, undefined, { signal: stop.signal }).catch(
            () => undefined,
          );
        }
      } finally {
        redis.disconnect();
        await jobs.close();
      }
    } else {
      const service = app.get(CheckoutService);
      const worker = new Worker<PaymentJob>(
        queue,
        (job) => reconcilePaymentJob(db, service, job),
        {
          connection: redis,
          concurrency: 4,
        },
      );
      worker.on('error', () =>
        eventLog('warn', 'payment_worker_error', {
          queue,
          code: 'worker_error',
        }),
      );
      worker.on('failed', (job) =>
        eventLog('warn', 'payment_job_failed', {
          queue,
          ...(safePaymentJobId(job?.id) ? { jobId: job.id } : {}),
          attempt: job?.attemptsMade,
          code: 'job_failed',
        }),
      );
      worker.on('stalled', (jobId) =>
        eventLog('warn', 'payment_job_stalled', {
          queue,
          ...(safePaymentJobId(jobId) ? { jobId } : {}),
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
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await app.close();
  }
}

void main().catch(() => {
  eventLog('error', 'payment_reconciliation_process_failed', {
    queue,
    code: 'process_error',
  });
  process.exitCode = 1;
});
