jest.mock('@nestjs/mongoose', () => ({ InjectModel: () => () => undefined }));
jest.mock('@nestjs/jwt', () => ({ JwtService: class {} }));
jest.mock('./pos-passkey.service', () => ({ PosPasskeyService: class {} }));
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { PosService } from '../src/pos/pos.service';
import { PosTransferService } from '../src/pos/pos-transfer.service';
import { ProductSchema, StockLogSchema, HubSchema, UserSchema, CustomerSchema, SaleSchema, RoleSchema } from '../src/pos/schemas/crm-models';
import { PosDeviceSchema, PosTransferSchema } from '../src/pos/schemas/pos-models';
import { PosJwtPayload } from '../src/pos/pos-auth';
import { ProviderFailure, TRANSFER_NEEDS_REVIEW } from '../src/pos/payment-provider';

jest.setTimeout(600_000);
describe('payment reservations with real MongoDB transactions', () => {
  let replica: MongoMemoryReplSet, db: Connection, other: Connection;
  let products: Model<any>, logs: Model<any>, transfers: Model<any>, hubs: Model<any>, users: Model<any>;
  let pos: PosService, service: PosTransferService, provider: any;
  const cashierRole = new Types.ObjectId(), managerRole = new Types.ObjectId();
  const hub = new Types.ObjectId(), cashier = new Types.ObjectId(), manager = new Types.ObjectId(), product = new Types.ObjectId();
  const actor: PosJwtPayload = { sub: String(cashier), role: 'cashier', hubId: String(hub), deviceId: 'device-1' };
  const payload = (id: string, quantity = 2) => ({ clientSaleId: id, hubId: String(hub), deviceId: actor.deviceId, lines: [{ productId: String(product), saleUnit: 'Units', qty: quantity }] });

  beforeAll(async () => {
    mongoose.set('transactionAsyncLocalStorage', true);
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    db = await mongoose.createConnection(replica.getUri(), { dbName: 'payments' }).asPromise();
    other = await mongoose.createConnection(replica.getUri(), { dbName: 'payments' }).asPromise();
    products = db.model('Product', ProductSchema.clone()); logs = db.model('StockLog', StockLogSchema.clone());
    transfers = db.model('PosTransfer', PosTransferSchema.clone()); hubs = db.model('Hub', HubSchema.clone()); users = db.model('User', UserSchema.clone());
    const customers = db.model('Customer', CustomerSchema.clone()), sales = db.model('Sale', SaleSchema.clone()), devices = db.model('PosDevice', PosDeviceSchema.clone());
    db.model('Role', RoleSchema.clone());
    other.model('Product', ProductSchema.clone()); other.model('StockLog', StockLogSchema.clone());
    await Promise.all(Object.values(db.models).map(model => model.init()));
    pos = Object.create(PosService.prototype);
    Object.assign(pos, { productModel: products, stockLogModel: logs, saleModel: sales, deviceModel: devices, hubModel: hubs });
    service = new PosTransferService(transfers, pos, hubs, users, customers);
    provider = { open: jest.fn(async input => ({ checkoutId: input.clientSaleId, payableKobo: input.amountKobo + 100,
      bankName: 'Test Bank', accountName: 'Test Store', accountNumber: '0123456789', currency: 'NGN' })),
      check: jest.fn(), webhook: jest.fn() };
    jest.spyOn(service as any, 'provider').mockImplementation(() => provider);
  });
  afterAll(async () => { await other?.close(); await db?.close(); await replica?.stop(); });
  beforeEach(async () => {
    // Raw collection cleanup is test-only; production writes always use the guards.
    for (const model of Object.values(db.models)) await model.collection.deleteMany({});
    await hubs.create({ _id: hub, hub_name: 'Lagos', hub_manager: manager, pos_manual_payment_confirmation: true, is_active: true });
    await db.model('Role').create([{ _id: cashierRole, name: 'cashier' }, { _id: managerRole, name: 'hub_manager' }]);
    await users.create({ _id: manager, role: managerRole, email: 'manager@example.com', is_active: true });
    await users.create({ _id: cashier, hub, role: cashierRole, email: 'cashier@example.com', is_active: true });
    await products.create({ _id: product, hub, name: 'Rice', unit_of_measure: 'Units', current_stock: 10, base_selling_price: 100 });
    await db.model('PosDevice').create({ device_id: 'device-1', hub });
    await db.transaction(async () => { await logs.create({ item: product, type: 'PURCHASE', quantity: 10, unit_price: 100, unit_cost: 50, batch_number: 'B1', date: new Date() }); });
    await db.collection('pos_payment_rollout').updateOne({ _id: 'reservations-v1' as any }, { $set: { ready: true } }, { upsert: true });
    process.env.POS_PAYMENT_RESERVATIONS_ENABLED = 'true';
    provider.open.mockClear(); provider.check.mockReset();
  });

  it('holds stock without recognizing a sale; retries do not reserve twice', async () => {
    const first = await service.start(actor, payload('hold'));
    await service.start(actor, payload('hold'));
    expect(first.feeKobo).toBe(100);
    expect((await products.findById(product)).reserved_stock).toBe(2);
    expect(await db.model('Sale').countDocuments()).toBe(0);
    expect(provider.open).toHaveBeenCalledTimes(1);
  });
  it('allows only one of two tills to reserve the last units', async () => {
    const results = await Promise.allSettled([service.start(actor, payload('race-1', 8)), service.start(actor, payload('race-2', 8))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await products.findById(product)).reserved_stock).toBe(8);
  });
  it('rolls back a multi-product hold if any product is unavailable', async () => {
    const second = new Types.ObjectId();
    await products.create({ _id: second, hub, name: 'Beans', current_stock: 1, unit_of_measure: 'Units', base_selling_price: 100 });
    await db.transaction(async () => { await logs.create({ item: second, type: 'PURCHASE', quantity: 1, unit_price: 100, batch_number: 'B1', date: new Date() }); });
    const request = payload('multi', 2); request.lines.push({ productId: String(second), saleUnit: 'Units', qty: 2 });
    await expect(service.start(actor, request)).rejects.toThrow();
    expect((await products.findById(product)).reserved_stock).toBe(0);
    expect(await transfers.countDocuments()).toBe(0);
  });
  it('converts carton quantities into stock units before reserving', async () => {
    await db.transaction(async () => {
      await products.updateOne({ _id: product }, { $set: { unit_of_measure: 'Cartons', carton_weight: 5, carton_price: 500 } });
      await logs.updateMany({ item: product }, { $set: { carton_weight: 5, carton_price: 500 } });
    });
    const request = payload('carton', 1); request.lines[0].saleUnit = 'Carton';
    await service.start(actor, request);
    expect((await products.findById(product)).reserved_stock).toBe(1);
  });
  it('blocks CRM stock reductions and reserved-batch consumption on another connection', async () => {
    await service.start(actor, payload('crm', 8));
    await expect(other.transaction(async () => { await other.model('Product').updateOne({ _id: product }, { $set: { current_stock: 1 } }); })).rejects.toThrow(/stock|reserved/i);
    await expect(other.transaction(async () => { await other.model('StockLog').create({ item: product, type: 'SALE', quantity: -3, batch_number: 'B1', date: new Date() }); })).rejects.toThrow(/reserved/i);
    await other.transaction(async () => {
      await other.model('StockLog').create({ item: product, type: 'SALE', quantity: -2, batch_number: 'B1', date: new Date() });
      await other.model('Product').updateOne({ _id: product }, { $inc: { current_stock: -2 } });
    });
    expect((await products.findById(product)).current_stock).toBe(8);
  });
  it('serializes manual confirmation, polling and webhook completion into one sale', async () => {
    const payment = await service.start(actor, payload('complete'));
    const evidence = { reference: 'complete', eventId: 'webhook-1', status: 'paid', amountKobo: payment.payableKobo, currency: 'NGN' };
    await Promise.all([service.confirmReceived(actor, 'complete'), (service as any).applyEvidence('complete', evidence), service.confirmReceived(actor, 'complete')]);
    expect(await db.model('Sale').countDocuments()).toBe(1);
    const current = await products.findById(product);
    expect(current.current_stock).toBe(8); expect(current.reserved_stock).toBe(0);
    expect((await transfers.findOne({ client_sale_id: 'complete' })).reservation_state).toBe('consumed');
  });
  it('keeps expired stock held, then releases exactly once on cancellation', async () => {
    await service.start(actor, payload('expiry'));
    await (service as any).applyEvidence('expiry', { reference: 'expiry', eventId: 'expire', status: 'expired' });
    expect((await products.findById(product)).reserved_stock).toBe(2);
    await service.cancel(actor, 'expiry'); await service.cancel(actor, 'expiry');
    expect((await products.findById(product)).reserved_stock).toBe(0);
  });
  it('requires the setting and originating cashier or assigned location manager', async () => {
    await service.start(actor, payload('permissions'));
    await expect(service.confirmReceived({ ...actor, sub: String(new Types.ObjectId()) }, 'permissions')).rejects.toThrow(/not assigned/);
    await expect(service.confirmReceived({ ...actor, role: 'manager', hubId: String(new Types.ObjectId()) }, 'permissions')).rejects.toThrow(/not assigned/);
    await hubs.updateOne({ _id: hub }, { $set: { pos_manual_payment_confirmation: false } });
    await expect(service.confirmReceived(actor, 'permissions')).rejects.toThrow(/disabled/);
    expect((await products.findById(product)).reserved_stock).toBe(2);
    await hubs.updateOne({ _id: hub }, { $set: { pos_manual_payment_confirmation: true } });
    await service.confirmReceived({ ...actor, sub: String(manager), role: 'manager' }, 'permissions');
    expect((await transfers.findOne({ client_sale_id: 'permissions' })).confirmed_by.toString()).toBe(String(manager));
  });
  it('does not consume stock on invalid evidence or late payment after cancellation', async () => {
    const payment = await service.start(actor, payload('late'));
    await (service as any).applyEvidence('late', { reference: 'late', eventId: 'short', status: 'paid', amountKobo: 1, currency: 'USD' });
    expect(await db.model('Sale').countDocuments()).toBe(0);
    await service.cancel(actor, 'late');
    await (service as any).applyEvidence('late', { reference: 'late', eventId: 'late-payment', status: 'paid', amountKobo: payment.payableKobo, currency: 'NGN' });
    const row = await transfers.findOne({ client_sale_id: 'late' });
    expect(row.status).toBe('cancelled'); expect(row.reconciliation_events).toHaveLength(2);
    expect(await db.model('Sale').countDocuments()).toBe(0);
    expect((await products.findById(product)).current_stock).toBe(10);
  });
  it('releases definitive initialization failures but retains ambiguous failures', async () => {
    provider.open.mockRejectedValueOnce(new ProviderFailure('Rejected', true));
    await expect(service.start(actor, payload('rejected'))).rejects.toThrow('Rejected');
    expect((await transfers.findOne({ client_sale_id: 'rejected' })).status).toBe('cancelled');
    expect((await products.findById(product)).reserved_stock).toBe(0);
    provider.open.mockRejectedValueOnce(new ProviderFailure('Timeout', false));
    const timeout = await service.start(actor, payload('timeout'));
    expect(timeout.status).toBe('review');
    expect(timeout.reconciliationReason).toBe(TRANSFER_NEEDS_REVIEW);
    expect((await products.findById(product)).reserved_stock).toBe(2);
  });
  it('uses the customer email or manager email, and blocks a missing email', async () => {
    const customer = await db.model('Customer').create({ customer_name: 'Buyer', customer_location: hub, customer_email: 'buyer@example.com', customer_type: 'Individual', customer_phone: '08000000000', assigned_agent: cashier, added_by: cashier });
    expect(await (service as any).email({ customerId: String(customer._id) }, String(hub))).toBe('buyer@example.com');
    expect(await (service as any).email({}, String(hub))).toBe('manager@example.com');
    await users.updateOne({ _id: manager }, { $unset: { email: 1 } });
    await expect((service as any).email({}, String(hub))).rejects.toThrow(/email/);
  });
  it('rolls back stock release and sale creation if finalization fails', async () => {
    await service.start(actor, payload('rollback'));
    const create = jest.spyOn(pos, 'createSale').mockRejectedValueOnce(new Error('Write failed'));
    await expect(service.confirmReceived(actor, 'rollback')).rejects.toThrow('Write failed');
    create.mockRestore();
    expect((await products.findById(product)).reserved_stock).toBe(2);
    expect((await transfers.findOne({ client_sale_id: 'rollback' })).status).toBe('awaiting');
    expect(await db.model('Sale').countDocuments()).toBe(0);
  });
  it('serializes CRM consumption against a simultaneous hold', async () => {
    const results = await Promise.allSettled([
      service.start(actor, payload('cross-service-race', 8)),
      other.transaction(async () => {
        await other.model('StockLog').create({ item: product, type: 'SALE', quantity: -7, batch_number: 'B1', date: new Date() });
        await other.model('Product').updateOne({ _id: product }, { $inc: { current_stock: -7 } });
      }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const current = await products.findById(product);
    expect(current.current_stock).toBeGreaterThanOrEqual(current.reserved_stock);
  });
  it('rejects approval from a demoted manager with a stale session', async () => {
    await service.start(actor, payload('demoted'));
    await users.updateOne({ _id: manager }, { $set: { role: cashierRole } });
    await expect(service.confirmReceived({ ...actor, sub: String(manager), role: 'manager' }, 'demoted')).rejects.toThrow(/currently assigned/);
  });
  it('prices every batch from the SKU and reserves oldest receipts first', async () => {
    await db.transaction(async () => {
      await logs.updateMany({ item: product }, { $set: { quantity: 4, quantity_remaining: 4, date: new Date('2026-01-01'), expiry_date: new Date('2027-01-01'), unit_price: 1 } });
      await logs.create({ item: product, type: 'PURCHASE', quantity: 6, quantity_remaining: 6, batch_number: 'B2', date: new Date('2026-02-01'), expiry_date: new Date('2026-03-01'), unit_price: 999, unit_cost: 80 });
      await products.updateOne({ _id: product }, { $set: { base_selling_price: 150 } });
    });
    const payment = await service.start(actor, payload('fifo', 7));
    expect(payment.cartTotalKobo).toBe(105000);
    const held = await transfers.findOne({ client_sale_id: 'fifo' });
    expect(held.priced_snapshot.lines.map(line => [line.batchNumber, line.stockQuantity])).toEqual([['B1', 4], ['B2', 3]]);
    await service.confirmReceived(actor, 'fifo');
    expect((await logs.findOne({ item: product, type: 'PURCHASE', batch_number: 'B1' })).quantity_remaining).toBe(0);
    expect((await logs.findOne({ item: product, type: 'PURCHASE', batch_number: 'B2' })).quantity_remaining).toBe(3);
    expect((await products.findById(product)).current_stock).toBe(3);
  });
  it('keeps a pending payment price while a SKU change reprices new sales', async () => {
    const old = await service.start(actor, payload('frozen-price'));
    await db.transaction(async () => { await products.updateOne({ _id: product }, { $set: { base_selling_price: 200 } }); });
    const next = await service.start(actor, payload('new-price'));
    expect(next.cartTotalKobo).toBe(old.cartTotalKobo * 2);
    await service.confirmReceived(actor, 'frozen-price');
    expect((await db.model('Sale').findOne({ client_sale_id: 'frozen-price' })).amount).toBe(old.cartTotalKobo / 100);
  });
});
