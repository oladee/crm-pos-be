import { Schema } from 'mongoose';

export const UserSchema = new Schema(
  {
    full_name: String,
    email: String,
    username: String,
    phone: String,
    role: { type: Schema.Types.ObjectId, ref: 'Role' },
    hub: { type: Schema.Types.ObjectId, ref: 'Hub' },
    is_active: { type: Boolean, default: true },
    password: String,
    pin_hash: String,
    auth_version: { type: Number, default: 0 },
  },
  { collection: 'users', timestamps: true },
);

export const RoleSchema = new Schema(
  {
    name: String,
    label: String,
  },
  { collection: 'roles' },
);

export const HubSchema = new Schema(
  {
    hub_name: String,
    hub_address: String,
    hub_phone: String,
    hub_manager: { type: Schema.Types.ObjectId, ref: 'User' },
    manager_name: String,
    code: String,
    is_active: Boolean,
    location_type: String,
    ownership_type: String,
    parent_hub: { type: Schema.Types.ObjectId, ref: 'Hub' },
  },
  { collection: 'hubs', timestamps: true },
);

export const ProductSchema = new Schema(
  {
    sku: String,
    name: String,
    category: String,
    unit_of_measure: String,
    current_stock: Number,
    base_selling_price: Number,
    carton_price: Number,
    carton_weight: Number,
    avg_unit_cost: Number,
    hub: { type: Schema.Types.ObjectId, ref: 'Hub' },
    is_active: Boolean,
  },
  { collection: 'products', timestamps: true },
);

const SaleItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product' },
    product_name: String,
    quantity: Number,
    unit: String,
    sale_unit: String,
    stock_quantity: Number,
    category: String,
    batch_number: String,
    unit_cost: Number,
    unit_price: Number,
  },
  { _id: false },
);

export const SaleSchema = new Schema(
  {
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    customer_name: { type: String, required: true },
    amount: { type: Number, required: true },
    profit_margin: { type: Number, default: 0 },
    profit_amount: { type: Number, default: 0 },
    date: { type: Date, required: true },
    agent: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    agent_name: { type: String, required: true },
    hub: { type: Schema.Types.ObjectId, ref: 'Hub', required: true },
    status: { type: String, default: 'Paid' },
    item: { type: SaleItemSchema, default: null },
    items: [SaleItemSchema],
    payment_terms: String,
    notes: String,
    channel: { type: String, default: 'POS' },
    delivery_status: { type: String, default: 'N/A' },
    payment_type: String,
    payment_mode: { type: String, default: 'Full Payment' },
    amount_paid: { type: Number, default: 0 },
    source: { type: String, default: 'pos' },
    client_sale_id: { type: String, sparse: true, unique: true },
    device_id: { type: String, index: true },
    reversal_of: String,
    reversal_kind: String,
  },
  { collection: 'sales', timestamps: true },
);

export const CustomerSchema = new Schema(
  {
    customer_type: { type: String, required: true },
    customer_name: { type: String, required: true },
    customer_phone: { type: String, required: true },
    customer_location: { type: Schema.Types.ObjectId, ref: 'Hub', required: true },
    assigned_agent: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    added_by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    joined_date: { type: Date, default: Date.now },
  },
  { collection: 'customers', timestamps: true },
);

export const StockLogSchema = new Schema(
  {
    item: { type: Schema.Types.ObjectId, ref: 'Product' },
    item_name: String,
    type: String,
    quantity: Number,
    uom: String,
    unit_cost: { type: Number, default: 0 },
    unit_price: { type: Number, default: 0 },
    reference_id: String,
    notes: String,
    agent: { type: Schema.Types.ObjectId, ref: 'User' },
    batch_number: String,
    carton_price: Number,
    carton_weight: Number,
    expiry_date: Date,
    supplier: String,
    from_hub: String,
    to_hub: String,
    reason: String,
    date: Date,
  },
  { collection: 'stocklogs', timestamps: true },
);
