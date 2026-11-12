const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createConnection, Types, set } = require('mongoose');
const { JwtService } = require('@nestjs/jwt');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const WebSocket = require('ws');
const { attachPosLive } = require('../dist/pos/live-gateway');
const { eventOutbox, eventQueue } = require('../dist/events/event-outbox');
const { dispatchEvent, processEvent } = require('../dist/events/event-jobs');
const { liveChannel, saveLiveNotice } = require('../dist/events/live-notices');

const redisBinary = process.env.EVENT_TEST_REDIS_BINARY;
const origin = 'http://localhost:3477';
const jwt = new JwtService({ secret: 'local-phase-3-test-only' });

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function until(check) {
  for (let n = 0; n < 120; n++) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  assert.fail('Expected live message or state did not arrive');
}

test(
  'live till socket validates scope and delivers durable notices by audience',
  {
    skip:
      !redisBinary && 'set EVENT_TEST_REDIS_BINARY for real WebSocket coverage',
    timeout: 60_000,
  },
  async () => {
    set('transactionAsyncLocalStorage', true);
    const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const db = await createConnection(repl.getUri()).asPromise();
    const probe = createServer();
    const redisPort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    const redisProcess = spawn(
      redisBinary,
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(redisPort),
        '--save',
        '',
        '--appendonly',
        'no',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    const url = `redis://127.0.0.1:${redisPort}`;
    const redis = new Redis(url);
    redis.on('error', () => {});
    const server = createServer();
    const sockets = [];
    let queue, worker;
    try {
      process.env.POS_LIVE_ENABLED = 'true';
      process.env.POS_FE_ORIGIN = origin;
      process.env.EVENT_REDIS_URL = url;
      await until(() => redis.status === 'ready');
      const hub = new Types.ObjectId(),
        rsp = new Types.ObjectId(),
        user = new Types.ObjectId(),
        foreign = new Types.ObjectId();
      const tills = db.db.collection('pos_devices');
      await tills.insertMany([
        { hub, device_id: 'Till-A', label: 'A' },
        { hub, device_id: 'Till-B', label: 'B' },
        { hub: rsp, device_id: 'Till-C' },
      ]);
      await db.db
        .collection('pos_shifts')
        .insertOne({ hub, device_id: 'Till-A', status: 'open' });
      await db.db
        .collection('pos_checkouts')
        .insertOne({ hub, device_id: 'Till-A', status: 'awaiting' });
      await attachPosLive(server, db, jwt, {
        actor: async (actor) => {
          if (
            !(await tills.findOne({
              hub: new Types.ObjectId(actor.hubId),
              device_id: actor.deviceId,
            }))
          )
            throw Error('wrong till');
        },
      });
      const port = await listen(server);
      const connect = async (kind, token) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/pos/live`, {
          origin,
        });
        sockets.push(socket);
        const received = [];
        socket.on('message', (message) =>
          received.push(JSON.parse(message.toString())),
        );
        await once(socket, 'open');
        socket.send(JSON.stringify({ type: 'authenticate', kind, token }));
        return { socket, received };
      };
      const ticket = async (userId, hubIds, admin) => {
        const token = randomBytes(32).toString('base64url');
        await db.db.collection('pos_live_tickets').insertOne({
          hash: createHash('sha256').update(token).digest('hex'),
          userId: String(userId),
          hubIds: hubIds.map(String),
          admin,
          expiresAt: new Date(Date.now() + 30_000),
        });
        return token;
      };
      const tillToken = (deviceId, subject = user) =>
        jwt.sign({
          sub: String(subject),
          role: 'cashier',
          hubId: String(hub),
          deviceId,
        });
      const originTill = await connect('till', tillToken('Till-A'));
      const otherTill = await connect('till', tillToken('Till-B', foreign));
      const crmToken = await ticket(user, [hub, rsp], true);
      const admin = await connect('crm', crmToken);
      await until(() =>
        admin.received.some((message) => message.type === 'snapshot'),
      );
      const unrelated = await connect(
        'crm',
        await ticket(foreign, [rsp], true),
      );
      const personal = await connect('crm', await ticket(user, [], false));
      const invalid = await connect('crm', crmToken);
      const [closeCode] = await once(invalid.socket, 'close');
      assert.equal(closeCode, 1008);
      const badOrigin = new WebSocket(`ws://127.0.0.1:${port}/pos/live`, {
        origin: 'https://untrusted.test',
      });
      const [originError] = await once(badOrigin, 'error').then((error) => [
        error[0],
      ]);
      assert.ok(originError);
      await until(() =>
        [unrelated, personal].every((client) =>
          client.received.some((message) => message.type === 'snapshot'),
        ),
      );
      assert.deepEqual(
        admin.received
          .find((message) => message.type === 'snapshot')
          .tills.map((row) => row.tillId)
          .sort(),
        ['Till-A', 'Till-B', 'Till-C'],
      );
      assert.deepEqual(
        unrelated.received
          .find((message) => message.type === 'snapshot')
          .tills.map((row) => row.tillId),
        ['Till-C'],
      );
      assert.equal(
        personal.received.find((message) => message.type === 'snapshot').tills
          .length,
        0,
      );

      const activity = (seq, value) =>
        originTill.socket.send(
          JSON.stringify({
            type: 'heartbeat',
            seq,
            activity: value,
            customerName: 'do not persist',
          }),
        );
      activity(2, 'selecting-customer');
      await until(
        async () =>
          (await tills.findOne({ device_id: 'Till-A' })).live_seq === 2,
      );
      activity(1, 'idle');
      await delay(100);
      assert.equal(
        (await tills.findOne({ device_id: 'Till-A' })).live_activity,
        'selecting-customer',
      );
      assert.equal(
        await db.db.collection('pos_live_activity').countDocuments(),
        1,
      );
      const last = await db.db.collection('pos_live_activity').findOne();
      assert.equal(last.customerName, undefined);
      admin.socket.send(JSON.stringify({ type: 'snapshot' }));
      const live = await until(() =>
        admin.received.filter((message) => message.type === 'snapshot').at(1),
      );
      const active = live.tills.find((row) => row.tillId === 'Till-A');
      assert.equal(active.activity, 'selecting-customer');
      assert.equal(active.shift, 'open');
      assert.equal(active.awaitingPayment, true);
      const ack = await until(() =>
        originTill.received.find((message) => message.type === 'heartbeat'),
      );
      assert.equal(ack.transportReady, true);

      // A payment or shift can change independently of an offline till.
      originTill.socket.close();
      await db.db
        .collection('pos_shifts')
        .updateOne(
          { hub, device_id: 'Till-A' },
          { $set: { status: 'closed' } },
        );
      await db.db
        .collection('pos_checkouts')
        .updateOne(
          { hub, device_id: 'Till-A' },
          { $set: { status: 'completed' } },
        );
      await delay(550);
      admin.socket.send(JSON.stringify({ type: 'snapshot' }));
      const offline = await until(() =>
        admin.received.filter((message) => message.type === 'snapshot').at(2),
      );
      assert.equal(
        offline.tills.find((row) => row.tillId === 'Till-A').shift,
        'closed',
      );
      assert.equal(
        offline.tills.find((row) => row.tillId === 'Till-A').awaitingPayment,
        false,
      );
      const currentTill = await connect('till', tillToken('Till-A'));

      const outbox = eventOutbox(db);
      await outbox.createIndexes();
      await db.transaction(async () => {
        await saveLiveNotice(db, {
          sourceKey: 'till',
          audience: { kind: 'till', hubId: String(hub), tillId: 'Till-A' },
          kind: 'payment-confirmed',
          title: 'Payment confirmed',
          reference: 'receipt-1',
        });
        await saveLiveNotice(db, {
          sourceKey: 'admin',
          audience: {
            kind: 'location-role',
            hubId: String(hub),
            role: 'pos-admin',
          },
          kind: 'payment-review',
          title: 'Review needed',
        });
        await saveLiveNotice(db, {
          sourceKey: 'personal',
          audience: { kind: 'user', userId: String(user) },
          kind: 'personal',
          title: 'Personal result ready',
        });
        await saveLiveNotice(db, {
          sourceKey: 'personal',
          audience: { kind: 'user', userId: String(user) },
          kind: 'personal',
          title: 'Personal result ready',
        });
      });
      assert.equal(await outbox.countDocuments(), 3);
      queue = new Queue(eventQueue, { connection: redis });
      worker = new Worker(
        eventQueue,
        (job) =>
          processEvent(outbox, job, (id) =>
            redis.publish(liveChannel, JSON.stringify({ noticeId: id })),
          ),
        { connection: { host: '127.0.0.1', port: redisPort } },
      );
      worker.on('error', () => {});
      await worker.waitUntilReady();
      while (
        await dispatchEvent(outbox, queue, () => redis.status === 'ready')
      ) {
        /* drain */
      }
      const delivered = (client) =>
        client.received
          .filter((message) => message.type === 'notification')
          .map((message) => message.item.kind)
          .sort();
      await until(
        () =>
          delivered(currentTill).length === 2 &&
          delivered(admin).length === 2 &&
          delivered(personal).length === 1,
      );
      assert.deepEqual(delivered(currentTill), [
        'payment-confirmed',
        'personal',
      ]);
      assert.deepEqual(delivered(admin), ['payment-review', 'personal']);
      assert.deepEqual(delivered(personal), ['personal']);
      assert.deepEqual(delivered(otherTill), []);
      assert.deepEqual(delivered(unrelated), []);

      currentTill.socket.close();
      const reconnect = await connect('till', tillToken('Till-A'));
      const recovery = await until(() =>
        reconnect.received.find((message) => message.type === 'notifications'),
      );
      assert.deepEqual(recovery.items.map((item) => item.kind).sort(), [
        'payment-confirmed',
        'personal',
      ]);
      assert.deepEqual(delivered(reconnect), []);
      originTill.socket.terminate();
    } finally {
      for (const socket of sockets) socket.terminate();
      if (worker) await worker.close();
      if (queue) await queue.close();
      redis.disconnect();
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
      if (redisProcess.exitCode === null && redisProcess.signalCode === null) {
        const exited = once(redisProcess, 'exit');
        redisProcess.kill();
        await exited;
      }
      await db.close();
      await repl.stop();
    }
  },
);
