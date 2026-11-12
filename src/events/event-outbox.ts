import { randomUUID } from 'node:crypto';
import { Schema, Types, type ClientSession, type Connection } from 'mongoose';

export const eventQueue = 'platform-events-v1';
export const diagnosticEvent = 'diagnostic.requested.v1';

const outboxSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    hubId: { type: Schema.Types.ObjectId, required: true },
    correlationId: { type: String, required: true },
    type: { type: String, required: true, enum: [diagnosticEvent] },
    occurredAt: { type: Date, required: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'completed', 'failed'],
    },
    generation: { type: Number, required: true },
    nextDispatchAt: Date,
    completedAt: Date,
    failedAt: Date,
    cleanupGenerations: { type: [Number], default: undefined },
    nextCleanupAt: Date,
  },
  { collection: 'event_outbox' },
);
outboxSchema.index({ status: 1, nextDispatchAt: 1 });
outboxSchema.index({ nextCleanupAt: 1 }, { sparse: true });

export const eventOutbox = (db: Connection) =>
  db.model('EventOutbox', outboxSchema);
export type EventOutbox = ReturnType<typeof eventOutbox>;

export function parseHubId(value?: string): Types.ObjectId {
  if (!value || !/^[0-9a-f]{24}$/i.test(value))
    throw new Error('invalid_hub_id');
  return new Types.ObjectId(value);
}

export function isEventId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export async function publishDiagnostic(
  outbox: EventOutbox,
  session: ClientSession,
  hubId: Types.ObjectId,
  correlationId = randomUUID() as string,
) {
  if (!session.inTransaction()) throw new Error('event_transaction_required');
  if (!isEventId(correlationId)) throw new Error('invalid_correlation_id');
  const now = new Date();
  const [event] = await outbox.create(
    [
      {
        eventId: randomUUID(),
        hubId,
        correlationId,
        type: diagnosticEvent,
        occurredAt: now,
        status: 'pending',
        generation: 0,
        nextDispatchAt: now,
      },
    ],
    { session },
  );
  return event;
}

export async function replayEvent(
  outbox: EventOutbox,
  hubId: Types.ObjectId,
  eventId: string,
) {
  if (!isEventId(eventId)) throw new Error('invalid_event_id');
  return outbox
    .findOneAndUpdate(
      { eventId, hubId, status: 'failed' },
      {
        $set: { status: 'pending', nextDispatchAt: new Date() },
        $unset: { failedAt: 1 },
        $inc: { generation: 1 },
      },
      { returnDocument: 'after' },
    )
    .lean();
}
