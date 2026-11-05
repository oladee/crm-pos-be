import { Schema } from 'mongoose';

export const PosCheckoutSchema = new Schema({
  client_sale_id: { type: String, required: true, unique: true },
  kind: { type: String, enum: ['sale', 'repayment'], default: 'sale' },
  hub: { type: Schema.Types.ObjectId, ref: 'Hub', required: true }, device_id: { type: String, required: true },
  cashier: { type: Schema.Types.ObjectId, ref: 'User', required: true }, cashier_name: String,
  customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true }, customer_name: String,
  credit: { type: Schema.Types.ObjectId, ref: 'CreditRecord' }, sale_id: { type: Schema.Types.ObjectId, ref: 'Sale' },
  status: { type: String, enum: ['awaiting', 'completed', 'cancelled', 'review'], default: 'awaiting' },
  mode: { type: String, enum: ['full_payment', 'partial_credit', 'full_credit'], required: true },
  total_kobo: Number, due_kobo: Number, credit_kobo: Number, due_date: Date,
  reservation_state: { type: String, enum: ['held', 'consumed', 'released', 'none'] },
  snapshot: Schema.Types.Mixed, allocations: Schema.Types.Mixed, sale_payload: Schema.Types.Mixed,
  settled_attempt: String, receipt: Schema.Types.Mixed, confirmed_at: Date, confirmation_source: String,
  manual: Schema.Types.Mixed, review_reason: String,
}, { collection: 'pos_checkouts', timestamps: true });
PosCheckoutSchema.index({ hub: 1, cashier: 1, createdAt: -1 });

export const PosPaymentAttemptSchema = new Schema({
  checkout: { type: Schema.Types.ObjectId, ref: 'PosCheckout', required: true, index: true },
  client_attempt_id: { type: String, required: true }, merchant_reference: { type: String, required: true, unique: true },
  provider: { type: String, enum: ['moniepoint', 'squad'], required: true }, method: String,
  account_key: String, account_snapshot: Schema.Types.Mixed, terminal_serial: String, terminal_lock: String,
  status: { type: String, enum: ['queued', 'pending', 'unknown', 'paid', 'failed', 'review'], default: 'queued' },
  amount_kobo: Number, payable_kobo: Number, fee_kobo: Number, instructions: Schema.Types.Mixed,
  review_reason: String, failures: { type: Number, default: 0 }, next_check: Date,
  lease_owner: String, lease_until: Date,
}, { collection: 'pos_payment_attempts', timestamps: true });
PosPaymentAttemptSchema.index({ checkout: 1, client_attempt_id: 1 }, { unique: true });
PosPaymentAttemptSchema.index({ status: 1, next_check: 1 });

export const PosTerminalLockSchema = new Schema({
  _id: String, attempt: { type: Schema.Types.ObjectId, ref: 'PosPaymentAttempt', required: true },
}, { collection: 'pos_terminal_locks', timestamps: true });

export const PosWebhookInboxSchema = new Schema({
  provider: String, account_key: String, event_id: String, evidence: Schema.Types.Mixed,
  state: { type: String, enum: ['pending', 'done', 'review'], default: 'pending' },
  hub: { type: Schema.Types.ObjectId, ref: 'Hub' }, review_reason: String,
  lease_owner: String, lease_until: Date, received_at: { type: Date, default: Date.now },
}, { collection: 'pos_webhook_inbox', timestamps: true });
PosWebhookInboxSchema.index({ provider: 1, account_key: 1, event_id: 1 }, { unique: true });
PosWebhookInboxSchema.index({ state: 1, lease_until: 1 });
PosWebhookInboxSchema.index({ hub: 1, state: 1, received_at: -1 });

export const PosProviderTransactionSchema = new Schema({
  provider: String, account_key: String, transaction_reference: String,
  checkout: { type: Schema.Types.ObjectId, ref: 'PosCheckout' }, merchant_reference: String, amount_kobo: Number,
}, { collection: 'pos_provider_transactions', timestamps: true });
PosProviderTransactionSchema.index({ provider: 1, account_key: 1, transaction_reference: 1 }, { unique: true });

// Mirrors CRM's shared collection. Money is converted from kobo at this boundary.
export const CreditRecordSchema = new Schema({
  customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true }, customer_name: String,
  sale: { type: Schema.Types.ObjectId, ref: 'Sale', required: true, unique: true }, sale_reference: String,
  amount_owed: Number, original_amount: Number, date_issued: Date, due_date: Date, last_payment_date: Date,
  status: String, payment_terms: String, payments: { type: [Schema.Types.Mixed], default: [] },
  repayment_timelines: { type: [Number], default: [] }, due_date_extensions: { type: [Schema.Types.Mixed], default: [] },
  extension_count: { type: Number, default: 0 }, flagged: { type: Boolean, default: false },
}, { collection: 'creditrecords', timestamps: true });
