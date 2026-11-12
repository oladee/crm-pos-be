import {
  type ClientSession,
  type Document,
  type Model,
  type Schema,
  Types,
} from 'mongoose';

type SaleFields = {
  customer?: Types.ObjectId | null;
  hub?: Types.ObjectId | null;
  date?: Date;
};
type SaleDocument = Document<Types.ObjectId> & SaleFields;
type SaleDay = {
  customerId: Types.ObjectId | null;
  hubId: Types.ObjectId | null;
  day: string;
};
type SaleChange = { before: SaleDay | null; after: SaleDay | null };
const watched = ['customer', 'hub', 'date', 'amount', 'status'];

function key(row?: SaleFields | null): SaleDay | null {
  if (!row?.date || !Number.isFinite(+row.date)) return null;
  return {
    customerId: row.customer ?? null,
    hubId: row.hub ?? null,
    day: new Date(+row.date + 3_600_000).toISOString().slice(0, 10),
  };
}

function transaction(doc: SaleDocument, model: Model<SaleFields>) {
  return (
    doc.$session() ??
    ((model.db.base as any).transactionAsyncLocalStorage?.getStore()
      ?.session as ClientSession | undefined)
  );
}

export function registerEngagementSaleEvents(schema: Schema) {
  schema.pre('save', async function () {
    if (process.env.ENGAGEMENT_EVENTS_ENABLED !== 'true') return;
    const doc = this as unknown as SaleDocument;
    delete doc.$locals.engagementChange;
    if (!doc.isNew && !watched.some((field) => doc.isModified(field))) return;
    const model = doc.constructor as Model<SaleFields>;
    const session = transaction(doc, model);
    if (!session?.inTransaction())
      throw new Error('engagement_sale_transaction_required');
    const previous = doc.isNew
      ? null
      : await model
          .findById(doc._id)
          .select('customer hub date')
          .session(session)
          .lean();
    doc.$locals.engagementChange = { before: key(previous), after: key(doc) };
  });

  schema.post('save', async function (saved) {
    const doc = saved as unknown as SaleDocument;
    const change = doc.$locals.engagementChange as SaleChange | undefined;
    if (!change) return;
    delete doc.$locals.engagementChange;
    if (!change.before && !change.after) return;
    const model = doc.constructor as Model<SaleFields>;
    const session = transaction(doc, model);
    if (!session?.inTransaction())
      throw new Error('engagement_sale_transaction_required');
    const now = new Date(),
      eventId = new Types.ObjectId();
    await model.db.db!.collection('engagement_sale_events').insertOne(
      {
        _id: eventId,
        type: 'sale.changed.v1',
        saleId: doc._id,
        correlationId: String(eventId),
        hubId: change.after?.hubId ?? change.before?.hubId ?? null,
        before: change.before,
        after: change.after,
        state: 'pending',
        generation: 0,
        attempts: 0,
        occurredAt: now,
        nextDispatchAt: now,
      },
      { session },
    );
  });
}
