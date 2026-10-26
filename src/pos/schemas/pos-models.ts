import { Schema } from 'mongoose';

export const PosShiftSchema = new Schema(
  {
    client_shift_id: { type: String, required: true, unique: true },
    hub: { type: Schema.Types.ObjectId, ref: 'Hub', required: true, index: true },
    device_id: String,
    cashier: { type: Schema.Types.ObjectId, ref: 'User' },
    cashier_name: String,
    opened_at: Date,
    closed_at: Date,
    opening_float: Number,
    counted_cash: Number,
    expected_cash: Number,
    variance: Number,
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    note: String,
  },
  { collection: 'pos_shifts', timestamps: true },
);

export const PosAssistSchema = new Schema(
  {
    client_assist_id: { type: String, required: true, unique: true },
    hub: { type: Schema.Types.ObjectId, ref: 'Hub', required: true, index: true },
    device_id: String,
    shift_id: String,
    cashier: { type: Schema.Types.ObjectId, ref: 'User' },
    cashier_name: String,
    type: String,
    urgent: { type: Boolean, default: false },
    note: String,
    context: Schema.Types.Mixed,
    status: { type: String, default: 'open' },
    claimed_by: String,
    claimed_at: Date,
    resolved_by: String,
    resolved_at: Date,
    resolution: String,
    action: Schema.Types.Mixed,
  },
  { collection: 'pos_assists', timestamps: true },
);

export const PosStockCountSchema = new Schema(
  {
    day: { type: String, required: true },
    hub: { type: Schema.Types.ObjectId, ref: 'Hub', required: true, index: true },
    device_id: String,
    counts: { type: Schema.Types.Mixed, default: {} },
    counted_by: String,
    counted_at: Date,
    variances: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: 'pos_stock_counts', timestamps: true },
);

PosStockCountSchema.index({ hub: 1, day: 1, device_id: 1 }, { unique: true });

export const PosDeviceSchema = new Schema(
  {
    device_id: { type: String, required: true, unique: true },
    hub: { type: Schema.Types.ObjectId, ref: 'Hub', required: true, index: true },
    label: String,
    last_seen: Date,
    bound_at: Date,
    credential_id: String,
    public_key: String,
    sign_count: { type: Number, default: 0 },
    transports: { type: [String], default: undefined },
    revoked: { type: Boolean, default: false },
    credential_device_type: String,
    credential_backed_up: Boolean,
  },
  { collection: 'pos_devices', timestamps: true },
);

export const PosEnrollmentCodeSchema = new Schema(
  {
    code_hash: { type: String, required: true, unique: true },
    hub: { type: Schema.Types.ObjectId, ref: 'Hub', required: true, index: true },
    label: String,
    expires_at: { type: Date, required: true },
    used_at: Date,
    created_by: String,
  },
  { collection: 'pos_enrollment_codes', timestamps: true },
);

export const PosWebauthnChallengeSchema = new Schema(
  {
    device_id: { type: String, required: true, index: true },
    kind: { type: String, enum: ['registration', 'authentication'], required: true },
    challenge: { type: String, required: true },
    expires_at: { type: Date, required: true },
  },
  { collection: 'pos_webauthn_challenges', timestamps: true },
);

PosWebauthnChallengeSchema.index({ device_id: 1, kind: 1 }, { unique: true });

export const PosTransferSchema = new Schema(
  {
    client_sale_id: { type: String, required: true, unique: true },
    checkout_id: { type: String, index: true },
    hub: { type: Schema.Types.ObjectId, ref: 'Hub', required: true, index: true },
    device_id: { type: String, index: true },
    cashier: { type: Schema.Types.ObjectId, ref: 'User' },
    cashier_name: String,
    status: { type: String, enum: ['awaiting', 'paid', 'cancelled', 'expired'], default: 'awaiting', index: true },
    cart_total_kobo: { type: Number, required: true },
    payable_kobo: { type: Number, required: true },
    currency: { type: String, default: 'NGN' },
    bank_name: String,
    account_name: String,
    account_number: String,
    expires_at: Date,
    sale_payload: Schema.Types.Mixed,
    event_ids: { type: [String], default: [] },
    paid_at: Date,
  },
  { collection: 'pos_transfers', timestamps: true },
);
