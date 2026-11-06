import { Schema } from 'mongoose';

export const PspAuditSchema = new Schema({
  event_id: { type: String, required: true, unique: true }, exchange_id: { type: String, required: true },
  schema_version: { type: Number, required: true }, recorded_at: { type: Date, required: true },
  provider_id: { type: String, enum: ['moniepoint', 'squad', 'bachs'], required: true }, account_key: String,
  location_id: String, device_id: String, cashier_id: String, checkout_id: String, attempt_id: String,
  merchant_reference: String, provider_transaction_id: String, provider_request_id: String,
  terminal_serial: String, business_id: String, business_owner_id: String, amount_kobo: Number,
  direction: String, operation: String, stage: String, method: String, endpoint: String,
  event_type: String, delivery_id: String, verification_result: String, outcome: String,
  http_status: Number, elapsed_ms: Number, error_code: String, body_sha256: String, body_bytes: Number,
  payload: Schema.Types.Mixed, payload_format: String, record_sha256: { type: String, required: true },
}, { collection: 'pos_psp_audit', versionKey: false });
PspAuditSchema.index({ provider_id: 1, account_key: 1, recorded_at: -1 });
PspAuditSchema.index({ location_id: 1, _id: -1 });
PspAuditSchema.index({ merchant_reference: 1, recorded_at: -1 });
PspAuditSchema.index({ exchange_id: 1 });
// No TTL: retention is intentionally indefinite until an agreed policy exists.
PspAuditSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  throw new Error('Payment audit records are append-only');
});
