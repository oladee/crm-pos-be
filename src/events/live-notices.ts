import { randomUUID } from 'node:crypto';
import { type ClientSession, type Connection, Types } from 'mongoose';

export const liveChannel = 'pos-live-v1';
export const liveNoticeEvent = 'notification.ready.v1';
export type NoticeAudience =
  | { kind: 'till'; hubId: string; tillId: string }
  | { kind: 'location-role'; hubId: string; role: 'pos-admin' }
  | { kind: 'user'; userId: string };
type NoticeInput = {
  sourceKey: string;
  title: string;
  reference?: string;
} & (
  | {
      kind: 'payment-confirmed';
      audience: Extract<NoticeAudience, { kind: 'till' }>;
    }
  | {
      kind: 'payment-review';
      audience: Extract<NoticeAudience, { kind: 'location-role' }>;
    }
  | { kind: 'personal'; audience: Extract<NoticeAudience, { kind: 'user' }> }
);
export type LiveNotice = NoticeInput & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export async function saveLiveNotice(db: Connection, data: NoticeInput) {
  if (process.env.POS_LIVE_ENABLED !== 'true') return;
  const session = (db.base as any).transactionAsyncLocalStorage?.getStore()
    ?.session as ClientSession | undefined;
  if (!session?.inTransaction())
    throw new Error('notification_transaction_required');
  const now = new Date();
  const notice = { ...data, _id: new Types.ObjectId(), createdAt: now };
  const result = await db
    .db!.collection<LiveNotice>('pos_live_notices')
    .updateOne(
      { sourceKey: data.sourceKey },
      { $setOnInsert: notice },
      { session, upsert: true },
    );
  if (!result.upsertedCount) return;
  const eventId = randomUUID();
  await db.db!.collection('event_outbox').insertOne(
    {
      eventId,
      correlationId: eventId,
      type: liveNoticeEvent,
      status: 'pending',
      generation: 0,
      noticeId: notice._id,
      hubId:
        'hubId' in data.audience
          ? new Types.ObjectId(data.audience.hubId)
          : undefined,
      occurredAt: now,
      nextDispatchAt: now,
    },
    { session, ignoreUndefined: true },
  );
}
