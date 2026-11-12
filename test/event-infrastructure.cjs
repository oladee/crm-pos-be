const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createConnection, Types } = require('mongoose');
const {
  cleanupFailedEventJob,
  dispatchEvent,
  processEvent,
} = require('../dist/events/event-jobs');
const {
  eventOutbox,
  eventQueue,
  publishDiagnostic,
  replayEvent,
} = require('../dist/events/event-outbox');

const redisBinary = process.env.EVENT_TEST_REDIS_BINARY;
const secret = 'test-secret-should-never-reach-redis-or-logs';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function eventually(check, ms = 30_000) {
  const deadline = Date.now() + ms;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('Expected state was not reached before the deadline');
}

test(
  'durable BullMQ dispatch, retry, replay and hub isolation',
  {
    skip: !redisBinary && 'set EVENT_TEST_REDIS_BINARY to a local redis-server',
    timeout: 120_000,
  },
  async () => {
    const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const db = createConnection(repl.getUri());
    const outbox = eventOutbox(db);
    const port = await freePort();
    const address = { host: '127.0.0.1', port };
    const relayRedis = new Redis({
      ...address,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    relayRedis.on('error', () => {});
    const queue = new Queue(eventQueue, { connection: relayRedis });
    queue.on('error', () => {});
    const dispatch = () =>
      dispatchEvent(outbox, queue, () => relayRedis.status === 'ready');
    let redisProcess;
    let worker;
    let injectFailure = false;
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (value) => logs.push(String(value));
    console.error = (value) => logs.push(String(value));

    async function stopRedis() {
      if (
        !redisProcess ||
        redisProcess.exitCode !== null ||
        redisProcess.signalCode !== null
      )
        return;
      const exited = once(redisProcess, 'exit');
      redisProcess.kill();
      await exited;
    }

    async function startRedis() {
      redisProcess = spawn(
        redisBinary,
        [
          '--bind',
          '127.0.0.1',
          '--port',
          String(port),
          '--save',
          '',
          '--appendonly',
          'no',
        ],
        { stdio: 'ignore', windowsHide: true },
      );
      await eventually(() => relayRedis.status === 'ready');
    }

    try {
      await db.asPromise();
      await outbox.createIndexes();
      const hub = new Types.ObjectId();
      const rsp = new Types.ObjectId();
      await assert.rejects(
        db.transaction(async (session) => {
          await publishDiagnostic(outbox, session, hub);
          throw new Error('rollback');
        }),
        /rollback/,
      );
      assert.equal(await outbox.countDocuments(), 0);

      const event = await db.transaction((session) =>
        publishDiagnostic(outbox, session, hub),
      );
      assert.equal(await dispatch(), true);
      assert.equal((await outbox.findById(event._id)).status, 'pending');
      assert.ok(
        logs.some((line) => line.includes('event_dispatch_retry_scheduled')),
      );

      await startRedis();
      const rspEvent = await db.transaction((session) =>
        publishDiagnostic(outbox, session, rsp),
      );
      const rspJobId = `${rspEvent.eventId}-0`;
      assert.equal(await dispatch(), true);
      assert.deepEqual((await queue.getJob(rspJobId)).data, {
        eventId: rspEvent.eventId,
        generation: 0,
      });

      await stopRedis();
      await eventually(() => relayRedis.status !== 'ready');
      await startRedis();
      assert.equal(await queue.getJob(rspJobId), undefined);
      assert.equal((await outbox.findById(rspEvent._id)).status, 'pending');

      let failLookup = true;
      const failingOutbox = {
        findOne: (...args) => {
          if (failLookup && args[0].eventId === rspEvent.eventId) {
            failLookup = false;
            throw new Error(secret);
          }
          return outbox.findOne(...args);
        },
        updateOne: (...args) => {
          if (injectFailure && args[0].eventId === rspEvent.eventId)
            throw new Error(secret);
          return outbox.updateOne(...args);
        },
      };
      injectFailure = true;
      worker = new Worker(
        eventQueue,
        (job) => processEvent(failingOutbox, job),
        { connection: address },
      );
      worker.on('error', () => {});
      await worker.waitUntilReady();

      const pump = async () => {
        while (await dispatch()) {
          /* drain due events */
        }
      };
      await eventually(async () => {
        await pump();
        return (
          (await outbox.findById(event._id)).status === 'completed' &&
          (await outbox.findById(rspEvent._id)).status === 'failed'
        );
      }, 50_000);

      const failedJob = await queue.getJob(rspJobId);
      assert.equal(failedJob.attemptsMade, 5);
      assert.deepEqual(failedJob.data, {
        eventId: rspEvent.eventId,
        generation: 0,
      });
      assert.equal(failedJob.failedReason, 'event_commit_error');
      assert.ok(
        failedJob.stacktrace.some((entry) =>
          entry.includes('event_lookup_error'),
        ),
      );
      assert.ok(
        !JSON.stringify({
          data: failedJob.data,
          failedReason: failedJob.failedReason,
          stacktrace: failedJob.stacktrace,
        }).includes(secret),
      );
      assert.equal(await replayEvent(outbox, rsp, event.eventId), null);
      assert.equal(await replayEvent(outbox, hub, rspEvent.eventId), null);
      const replayed = await replayEvent(outbox, rsp, rspEvent.eventId);
      assert.equal(replayed.generation, 1);
      assert.equal(await replayEvent(outbox, rsp, rspEvent.eventId), null);
      await processEvent(outbox, failedJob);
      assert.equal((await outbox.findById(rspEvent._id)).status, 'pending');
      assert.equal((await outbox.findById(rspEvent._id)).generation, 1);

      assert.deepEqual(
        (await outbox.findById(rspEvent._id)).cleanupGenerations,
        [0],
      );
      assert.equal(
        await cleanupFailedEventJob(outbox, queue, () => false),
        false,
      );
      assert.ok(await queue.getJob(rspJobId));
      assert.equal(
        await cleanupFailedEventJob(outbox, queue, () => true),
        true,
      );
      assert.equal(await queue.getJob(rspJobId), undefined);
      assert.equal(
        (await outbox.findById(rspEvent._id)).cleanupGenerations,
        undefined,
      );

      const originalCompletion = (
        await outbox.findById(event._id)
      ).completedAt.getTime();
      await processEvent(outbox, {
        data: { eventId: event.eventId, generation: 0 },
        id: `${event.eventId}-0`,
        name: event.type,
        attemptsMade: 1,
      });
      assert.equal(
        (await outbox.findById(event._id)).completedAt.getTime(),
        originalCompletion,
      );

      injectFailure = false;
      await eventually(async () => {
        await pump();
        return (await outbox.findById(rspEvent._id)).status === 'completed';
      });
      const trace = logs
        .map((line) => JSON.parse(line))
        .filter((line) => line.correlationId === rspEvent.correlationId);
      assert.ok(
        trace.some((line) => line.action === 'event_retries_exhausted'),
      );
      assert.ok(trace.some((line) => line.action === 'event_completed'));
      assert.ok(!logs.join('\n').includes(secret));
      const payloads = trace.filter(
        (line) => line.action === 'event_dispatched',
      );
      assert.ok(payloads.every((line) => line.hubId === rsp.toString()));
    } finally {
      if (worker) await worker.close();
      relayRedis.disconnect();
      await queue.close();
      await stopRedis();
      console.log = originalLog;
      console.error = originalError;
      await db.close();
      await repl.stop();
    }
  },
);
