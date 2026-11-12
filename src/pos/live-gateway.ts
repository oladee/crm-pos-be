import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { type Connection, Types } from 'mongoose';
import { WebSocket, WebSocketServer } from 'ws';
import type { PosJwtPayload } from './pos-auth';
import type { CheckoutService } from './checkout.service';
import {
  liveChannel,
  type LiveNotice,
  type NoticeAudience,
} from '../events/live-notices';
import { eventLog } from '../events/event-jobs';

const activities = new Set([
  'idle',
  'building-cart',
  'selecting-customer',
  'checking-out',
  'awaiting-payment',
]);
const maxConnectionMs = 5 * 60_000;
type Viewer =
  | { kind: 'crm'; userId: string; hubIds: string[]; admin: boolean }
  | {
      kind: 'till';
      userId: string;
      hubId: string;
      tillId: string;
      admin: boolean;
      session: string;
    };
type Ticket = {
  hash: string;
  userId: string;
  hubIds: string[];
  admin: boolean;
  expiresAt: Date;
};

function mayReceive(viewer: Viewer, audience: NoticeAudience) {
  if (audience.kind === 'user') return audience.userId === viewer.userId;
  if (audience.kind === 'till')
    return (
      viewer.kind === 'till' &&
      audience.hubId === viewer.hubId &&
      audience.tillId === viewer.tillId
    );
  return (
    audience.role === 'pos-admin' &&
    viewer.admin &&
    (viewer.kind === 'crm'
      ? viewer.hubIds.includes(audience.hubId)
      : viewer.hubId === audience.hubId)
  );
}

export function noticeFilter(viewer: Viewer) {
  return {
    $or: [
      { 'audience.kind': 'user', 'audience.userId': viewer.userId },
      ...(viewer.kind === 'till'
        ? [
            {
              'audience.kind': 'till',
              'audience.hubId': viewer.hubId,
              'audience.tillId': viewer.tillId,
            },
          ]
        : []),
      ...(viewer.admin
        ? [
            {
              'audience.kind': 'location-role',
              'audience.role': 'pos-admin',
              'audience.hubId': {
                $in: viewer.kind === 'crm' ? viewer.hubIds : [viewer.hubId],
              },
            },
          ]
        : []),
    ],
  };
}

const objectId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const publicNotice = (notice: LiveNotice) => ({
  id: String(notice._id),
  kind: notice.kind,
  title: notice.title,
  reference: notice.reference,
  createdAt: notice.createdAt,
});

export async function attachPosLive(
  server: Server,
  db: Connection,
  jwt: JwtService,
  checkout: CheckoutService,
) {
  if (process.env.POS_LIVE_ENABLED !== 'true') return;
  const redisUrl = process.env.EVENT_REDIS_URL;
  if (!redisUrl) throw new Error('pos_live_redis_required');
  const mongo = db.db!;
  const notices = mongo.collection<LiveNotice>('pos_live_notices');
  const tickets = mongo.collection<Ticket>('pos_live_tickets');
  const timeline = mongo.collection('pos_live_activity');
  const devices = mongo.collection('pos_devices');
  await Promise.all([
    notices.createIndex({ sourceKey: 1 }, { unique: true }),
    notices.createIndex({ 'audience.userId': 1, createdAt: -1 }),
    notices.createIndex({ 'audience.hubId': 1, createdAt: -1 }),
    tickets.createIndex({ hash: 1 }, { unique: true }),
    tickets.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    timeline.createIndex({ hub: 1, at: -1 }),
  ]);

  const publish = new Redis(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2000,
  });
  const subscriber = new Redis(redisUrl);
  const logError = () =>
    eventLog('warn', 'pos_live_transport_unavailable', { queue: liveChannel });
  publish.on('error', logError);
  subscriber.on('error', logError);
  const origins = new Set(
    [
      ...(process.env.POS_FE_ORIGIN || 'http://localhost:3477').split(','),
      ...(process.env.POS_LIVE_CRM_ORIGINS || '').split(','),
    ]
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const sockets = new Map<WebSocket, Viewer>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
    perMessageDeflate: false,
  });
  const send = (socket: WebSocket, payload: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 256 * 1024) return socket.terminate();
    socket.send(JSON.stringify(payload));
  };
  let subscribed = false;
  const transportReady = () => subscribed && subscriber.status === 'ready';
  const sendTransport = () => {
    for (const socket of sockets.keys())
      send(socket, { type: 'transport', transportReady: transportReady() });
  };

  async function snapshot(socket: WebSocket, viewer: Viewer) {
    const recentNotices = await notices
      .find(noticeFilter(viewer))
      .sort({ createdAt: -1, _id: -1 })
      .limit(50)
      .toArray();
    send(socket, {
      type: 'notifications',
      items: recentNotices.map(publicNotice),
    });
    if (viewer.kind !== 'crm') return;
    const hub = { $in: viewer.hubIds.map((id) => new Types.ObjectId(id)) };
    const [rows, shifts, payments, history] = await Promise.all([
      devices
        .find({ hub, revoked: { $ne: true } })
        .project({
          hub: 1,
          device_id: 1,
          label: 1,
          live_last_seen: 1,
          live_activity: 1,
        })
        .toArray(),
      mongo
        .collection('pos_shifts')
        .find({ hub, status: 'open' })
        .project({ hub: 1, device_id: 1 })
        .toArray(),
      mongo
        .collection('pos_checkouts')
        .find({ hub, status: { $in: ['awaiting', 'review'] } })
        .project({ hub: 1, device_id: 1 })
        .toArray(),
      timeline
        .find({ hub })
        .project({ hub: 1, tillId: 1, activity: 1, at: 1 })
        .sort({ at: -1, _id: -1 })
        .limit(50)
        .toArray(),
    ]);
    const key = (row: { hub?: unknown; device_id?: unknown }) =>
      `${row.hub}/${row.device_id}`;
    const opened = new Set(shifts.map(key));
    const pending = new Set(payments.map(key));
    send(socket, {
      type: 'snapshot',
      tills: rows.map((row) => ({
        hubId: String(row.hub),
        tillId: row.device_id,
        label: row.label || row.device_id,
        lastSeen: row.live_last_seen ?? null,
        activity: row.live_activity ?? 'idle',
        shift: opened.has(key(row)) ? 'open' : 'closed',
        awaitingPayment: pending.has(key(row)),
      })),
      history,
    });
  }

  async function authenticate(message: any): Promise<Viewer> {
    if (message.type !== 'authenticate' || typeof message.token !== 'string')
      throw new Error('invalid_live_auth');
    if (message.kind === 'crm') {
      const hash = createHash('sha256').update(message.token).digest('hex');
      const ticket = await tickets.findOneAndDelete({
        hash,
        expiresAt: { $gt: new Date() },
      });
      if (!ticket || !objectId(ticket.userId))
        throw new Error('invalid_live_ticket');
      return {
        kind: 'crm',
        userId: ticket.userId,
        hubIds: ticket.hubIds.filter(objectId),
        admin: ticket.admin === true,
      };
    }
    if (message.kind !== 'till') throw new Error('invalid_live_viewer');
    const actor = jwt.verify<PosJwtPayload>(message.token);
    if (
      !objectId(actor.sub) ||
      !objectId(actor.hubId) ||
      !actor.deviceId ||
      !['cashier', 'manager'].includes(actor.role)
    )
      throw new Error('invalid_live_till');
    await checkout.actor(actor);
    const session = randomUUID();
    const result = await devices.updateOne(
      {
        device_id: actor.deviceId,
        hub: new Types.ObjectId(actor.hubId),
        revoked: { $ne: true },
      },
      {
        $set: {
          live_session: session,
          live_seq: 0,
          live_last_seen: new Date(),
        },
      },
    );
    if (!result.matchedCount) throw new Error('inactive_live_till');
    return {
      kind: 'till',
      userId: actor.sub,
      hubId: actor.hubId,
      tillId: actor.deviceId,
      admin: actor.role === 'manager',
      session,
    };
  }

  async function heartbeat(
    viewer: Extract<Viewer, { kind: 'till' }>,
    message: any,
  ) {
    if (
      !Number.isSafeInteger(message.seq) ||
      message.seq <= 0 ||
      !activities.has(message.activity)
    )
      return;
    const hub = new Types.ObjectId(viewer.hubId);
    const now = new Date();
    const matched = await db.transaction(async (session) => {
      const before = await devices.findOneAndUpdate(
        {
          hub,
          device_id: viewer.tillId,
          live_session: viewer.session,
          live_seq: { $lt: message.seq },
          revoked: { $ne: true },
        },
        {
          $set: {
            live_seq: message.seq,
            live_last_seen: now,
            live_activity: message.activity,
          },
        },
        { returnDocument: 'before', session },
      );
      if (!before) return false;
      if (before.live_activity !== message.activity) {
        await timeline.insertOne(
          { hub, tillId: viewer.tillId, activity: message.activity, at: now },
          { session },
        );
      }
      return true;
    });
    if (matched && publish.status === 'ready') {
      await publish
        .publish(liveChannel, JSON.stringify({ hubId: viewer.hubId }))
        .catch(logError);
    }
  }

  async function fanout(raw: string) {
    const message = JSON.parse(raw);
    if (objectId(message.noticeId)) {
      const notice = await notices.findOne({
        _id: new Types.ObjectId(message.noticeId),
      });
      if (!notice) return;
      for (const [socket, viewer] of sockets) {
        if (mayReceive(viewer, notice.audience))
          send(socket, { type: 'notification', item: publicNotice(notice) });
      }
    }
    if (objectId(message.hubId)) {
      for (const [socket, viewer] of sockets) {
        if (viewer.kind === 'crm' && viewer.hubIds.includes(message.hubId))
          send(socket, { type: 'refresh' });
      }
    }
  }
  subscriber.on('message', (_channel, raw) => {
    void fanout(raw).catch(logError);
  });
  subscriber.on('close', () => {
    subscribed = false;
    sendTransport();
  });
  subscriber.on('ready', () => {
    void subscriber
      .subscribe(liveChannel)
      .then(() => {
        subscribed = subscriber.status === 'ready';
        sendTransport();
        for (const socket of sockets.keys()) send(socket, { type: 'refresh' });
      })
      .catch(logError);
  });

  wss.on('connection', (socket) => {
    let authenticating = false;
    let lastSnapshot = 0;
    const authTimeout = setTimeout(() => socket.close(1008), 5000);
    const expiry = setTimeout(() => socket.close(4001), maxConnectionMs);
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearTimeout(authTimeout);
      clearTimeout(expiry);
      sockets.delete(socket);
    });
    socket.on('message', async (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        const viewer = sockets.get(socket);
        if (!viewer) {
          if (authenticating) return;
          authenticating = true;
          const authenticated = await authenticate(message);
          if (socket.readyState !== WebSocket.OPEN) return;
          sockets.set(socket, authenticated);
          clearTimeout(authTimeout);
          send(socket, {
            type: 'authenticated',
            transportReady: transportReady(),
          });
          await snapshot(socket, authenticated);
        } else if (message.type === 'heartbeat' && viewer.kind === 'till') {
          await heartbeat(viewer, message);
          send(socket, { type: 'heartbeat', transportReady: transportReady() });
        } else if (
          message.type === 'snapshot' &&
          Date.now() - lastSnapshot >= 500
        ) {
          lastSnapshot = Date.now();
          await snapshot(socket, viewer);
        }
      } catch {
        socket.close(1008);
      }
    });
  });
  server.on('upgrade', (request, socket, head) => {
    if (
      request.url !== '/pos/live' ||
      !origins.has(String(request.headers.origin))
    )
      return socket.destroy();
    wss.handleUpgrade(request, socket, head, (client) =>
      wss.emit('connection', client, request),
    );
  });
  server.on('close', () => {
    publish.disconnect();
    subscriber.disconnect();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
  });
}
