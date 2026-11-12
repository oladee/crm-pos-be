// Build first. Real Nest routes, MongoDB transactions and local HTTP provider simulations.
require('reflect-metadata');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { Types } = require('mongoose');

describe('customer checkout and payment recovery', () => {
  let replica, app, db, service, base, provider, providerBase, token, managerToken;
  const hub = new Types.ObjectId(), cashier = new Types.ObjectId(), manager = new Types.ObjectId(), customer = new Types.ObjectId(), product = new Types.ObjectId();
  const requests = new Map();
  let nextBehavior = 'normal', pushCalls = 0;
  const actor = { sub: String(cashier), role: 'cashier', hubId: String(hub), deviceId: 'till-1' };
  const draft = (id, overrides = {}) => ({ clientSaleId: id, customerId: String(customer), paymentMode: 'full_payment',
    lines: [{ productId: String(product), qty: 2, saleUnit: 'Units', discount: 0 }], ...overrides });

  async function api(path, body, auth = token) {
    const response = await fetch(base + '/pos' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  async function create(id, overrides) { const response = await api('/checkouts', draft(id, overrides)); assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data; }
  async function attempt(row, id = 'attempt-1', providerName = 'moniepoint', extra = {}) {
    const response = await api(`/checkouts/${row.id}/payment-attempts`, { clientAttemptId: id, provider: providerName, method: 'transfer', ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data;
  }
  async function manual(row, extra = {}, auth = token) {
    return api(`/checkouts/${row.id}/confirm-received`, { amountKobo: row.dueKobo, actualMethod: 'Transfer', account: 'Other bank account',
      reason: 'Checked bank receipt', confirmed: true, ...extra }, auth);
  }
  async function webhook(attemptRow, overrides = {}, signatureValid = true) {
    const reference = attemptRow.reference;
    const received = requests.get(reference);
    if (received) received.paid = true;
    const body = { eventId: `body-${reference}`, eventType: received?.paymentMethod === 'CARD_PURCHASE' ? 'V1_POS_PURCHASE_TRANSACTION' : 'V1_POS_TRANSFER_TRANSACTION',
      data: { businessId: 100, businessOwnerId: 101, terminalSerial: 'SERIAL-1', amount: attemptRow.payableKobo,
        merchantReference: reference, transactionReference: `txn-${reference}`, transactionType: 'POS_TRANSFER',
        transactionStatus: 'COMPLETED', responseCode: '20000', ...overrides } };
    const raw = JSON.stringify(body), id = `event-${body.data.transactionReference}`, timestamp = String(Date.now());
    const signature = crypto.createHmac('sha256', 'test-webhook-secret').update(`${id}__${timestamp}__${raw}`).digest('base64');
    const response = await fetch(base + '/pos/webhooks/moniepoint/lagos', { method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'moniepoint-webhook-id': id, 'moniepoint-webhook-timestamp': timestamp,
        'moniepoint-webhook-signature': signatureValid ? signature : 'bad' } });
    return response;
  }
  async function squadWebhook(payment) {
    requests.get(payment.reference).paid = true;
    const body = { merchant_reference: payment.reference, transaction_reference: `squad-txn-${payment.reference}`,
      amount_received: payment.payableKobo / 100, transaction_status: 'SUCCESS', currency: 'NGN' };
    const signed = JSON.stringify({ transaction_reference: body.transaction_reference, amount_received: body.amount_received, merchant_reference: body.merchant_reference });
    return fetch(base + '/pos/webhooks/squad', { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'x-squad-encrypted-body': crypto.createHmac('sha512', 'sandbox_test').update(signed).digest('hex') } });
  }

  before(async () => {
    process.env.POS_PAYMENT_WORKER_ENABLED = 'false'; process.env.POS_PAYMENT_RESERVATIONS_ENABLED = 'true';
    process.env.POS_PAYMENT_RECONCILIATION_MODE = 'legacy';
    process.env.MONIEPOINT_ENABLED = 'true'; process.env.MONIEPOINT_TEST_API_KEY = 'test-key'; process.env.MONIEPOINT_TEST_SECRET = 'test-webhook-secret';
    process.env.SQUAD_ENABLED = 'true'; process.env.SQUAD_DVA_APPROVED = 'true'; process.env.SQUAD_CONTRACT_VERIFIED = 'true'; process.env.SQUAD_SECRET_KEY = 'sandbox_test';
    process.env.MONIEPOINT_ACCOUNTS_JSON = JSON.stringify({ lagos: { businessId: '100', businessOwnerId: '101', apiKeyEnv: 'MONIEPOINT_TEST_API_KEY', webhookSecretEnv: 'MONIEPOINT_TEST_SECRET' } });
    process.env.MONIEPOINT_TERMINALS_JSON = JSON.stringify({ 'till-1': { hubId: String(hub), accountKey: 'lagos', terminalSerial: 'SERIAL-1' } });
    provider = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const path = new URL(req.url, 'http://localhost').pathname;
      const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (path === '/v1/transactions' && req.method === 'POST') {
        assert.equal(req.headers.authorization, 'Bearer test-key');
        const body = JSON.parse(raw); pushCalls++; requests.set(body.merchantReference, { ...body, paid: false });
        if (nextBehavior === 'early-webhook') {
          nextBehavior = 'normal';
          await webhook({ reference: body.merchantReference, payableKobo: body.amount }); await service.tick();
        }
        if (nextBehavior === 'timeout') { nextBehavior = 'normal'; setTimeout(() => { if (!res.destroyed) json({}, 202); }, 400); return; }
        if (nextBehavior === 'server-error') { nextBehavior = 'normal'; return json({}, 503); }
        if (nextBehavior === 'malformed') { nextBehavior = 'normal'; res.writeHead(502); res.end('not JSON'); return; }
        return json({}, 202);
      }
      if (path.startsWith('/v1/transactions/merchants/')) {
        const ref = decodeURIComponent(path.split('/').pop()), row = requests.get(ref);
        if (!row) return json({}, 404);
        return json({ merchantReference: ref, businessOwnerId: 101, terminalSerial: row.terminalSerial,
          processingStatus: row.paid ? 'PROCESSED' : 'PENDING', responseCode: row.paid ? '20000' : null,
          actualAmount: row.paid ? row.amount : null, transactionReference: row.paid ? `txn-${ref}` : '', actualPaymentMethod: row.paymentMethod });
      }
      if (path === '/virtual-account/initiate-dynamic-virtual-account') {
        const body = JSON.parse(raw); requests.set(body.transaction_ref, { amount: body.amount, paid: false });
        return json({ success: true, data: { transaction_reference: body.transaction_ref, expected_amount: (body.amount + 100) / 100,
          currency: 'NGN', account_number: '0123456789', bank: 'Test Bank', account_name: 'Lagos Store' } });
      }
      if (path.startsWith('/virtual-account/get-dynamic-virtual-account-transactions/')) {
        const ref = decodeURIComponent(path.split('/').pop()), row = requests.get(ref);
        return json({ success: true, data: { rows: row?.paid ? [{ transaction_status: 'SUCCESS', merchant_reference: ref,
          transaction_reference: `squad-txn-${ref}`, amount_received: (row.amount + 100) / 100, currency: 'NGN' }] : [] } });
      }
      return json({ message: 'Simulation endpoint not defined' }, 501);
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); providerBase = `http://127.0.0.1:${provider.address().port}`;
    process.env.MONIEPOINT_API_BASE_URL = providerBase; process.env.SQUAD_API_BASE_URL = providerBase;
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.NODE_ENV = 'dev'; process.env.MONGO_STRING_TEST = replica.getUri('checkout-v2'); process.env.JWT_SECRET = 'local-test-only';
    const { NestFactory } = require('@nestjs/core'), { getConnectionToken } = require('@nestjs/mongoose'), { JwtService } = require('@nestjs/jwt');
    const { AppModule } = require('../dist/app.module'), { CheckoutService } = require('../dist/pos/checkout.service');
    app = await NestFactory.create(AppModule, { rawBody: true, logger: false }); await app.listen(0, '127.0.0.1');
    base = await app.getUrl(); db = app.get(getConnectionToken()); service = app.get(CheckoutService);
    await Promise.all(Object.values(db.models).map(model => model.init()));
    token = app.get(JwtService).sign(actor); managerToken = app.get(JwtService).sign({ ...actor, sub: String(manager), role: 'manager' });
  });
  after(async () => { await app?.close(); await replica?.stop(); if (provider) await new Promise(resolve => provider.close(resolve)); });
  beforeEach(async () => {
    for (const model of Object.values(db.models)) await model.collection.deleteMany({});
    requests.clear(); pushCalls = 0; nextBehavior = 'normal'; process.env.MONIEPOINT_HTTP_TIMEOUT_MS = '1000'; process.env.MONIEPOINT_ENABLED = 'true';
    const cashierRole = await db.model('Role').create({ name: 'cashier' }), managerRole = await db.model('Role').create({ name: 'hub_manager' });
    await db.model('Hub').create({ _id: hub, hub_name: 'Lagos', hub_manager: manager, is_active: true });
    await db.model('User').create([{ _id: cashier, full_name: 'Cashier', email: 'cashier@example.test', hub, role: cashierRole._id }, { _id: manager, full_name: 'Manager', hub, role: managerRole._id }]);
    await db.model('PosDevice').create({ device_id: 'till-1', hub });
    await db.model('Customer').create({ _id: customer, customer_name: 'Buyer', customer_type: 'b2c', customer_location: hub, assigned_agent: cashier, added_by: cashier });
    await db.model('Product').create({ _id: product, name: 'Rice', sku: 'RICE', unit_of_measure: 'Units', current_stock: 10, base_selling_price: 100, hub });
    await db.transaction(async () => { await db.model('StockLog').create({ item: product, type: 'PURCHASE', quantity: 10, unit_price: 100, unit_cost: 50, batch_number: '001', date: new Date() }); });
    await db.collection('pos_payment_rollout').updateOne({ _id: 'reservations-v1' }, { $set: { ready: true } }, { upsert: true });
  });

  it('requires a customer from the location and accepts a new name without phone', async () => {
    assert.equal((await api('/checkouts', draft('missing', { customerId: undefined }))).status, 400);
    const response = await api('/customers', { name: 'Name only' }); assert.equal(response.status, 201); assert.equal(response.data.data.phone, undefined);
    const foreign = await db.model('Customer').create({ customer_name: 'Elsewhere', customer_type: 'b2c', customer_location: new Types.ObjectId(), assigned_agent: cashier, added_by: cashier });
    assert.equal((await api('/checkouts', draft('foreign', { customerId: String(foreign._id) }))).status, 400);
    assert.equal(await db.model('Sale').countDocuments(), 0);
  });
  it('manual completion is atomic and idempotent and uses the database customer name', async () => {
    const row = await create('manual', { customerName: 'Forged' }); assert.equal(row.customerName, 'Buyer');
    const results = await Promise.all([manual(row), manual(row)]); assert.ok(results.every(r => r.status === 201));
    assert.equal(await db.model('Sale').countDocuments(), 1); assert.equal((await db.model('Product').findById(product)).current_stock, 8);
    assert.equal((await db.model('Product').findById(product)).reserved_stock, 0);
    assert.equal(results[0].data.receipt.receiptPayment.confirmationSource, 'manual');
    assert.equal((await db.model('Customer').findById(customer)).total_orders, 1);
  });
  it('always offers standard checkout and explains missing providers without activation gating', async () => {
    process.env.MONIEPOINT_TERMINALS_JSON = '{}';
    process.env.SQUAD_ENABLED = 'false';
    try {
      const options = await api('/checkouts/options');
      assert.equal(options.data.enabled, true);
      assert.match(options.data.methods.find(method => method.id === 'moniepoint').reason, /No Moniepoint terminal/);
      assert.equal(options.data.methods.find(method => method.id === 'squad').available, false);
      const row = await create('always-standard');
      assert.equal(row.status, 'awaiting'); assert.equal(row.receipt, null);
      assert.equal(await db.model('Sale').countDocuments(), 0);
      assert.equal((await api('/payments/transfers', { ...draft('blocked-legacy'), provider: 'bachs' })).status, 409);
      assert.equal((await api('/sales', draft('blocked-direct'))).status, 409);
    } finally {
      process.env.MONIEPOINT_TERMINALS_JSON = JSON.stringify({ 'till-1': { hubId: String(hub), accountKey: 'lagos', terminalSerial: 'SERIAL-1' } });
      process.env.SQUAD_ENABLED = 'true';
    }
  });
  it('shares read-only location receipts across tills without granting payment management', async () => {
    const row = await create('shared-location'); await manual(row);
    const otherCashier = new Types.ObjectId();
    const role = await db.model('Role').findOne({ name: 'cashier' });
    await db.model('User').create({ _id: otherCashier, full_name: 'Other Cashier', role: role._id, hub });
    await db.model('PosDevice').create({ device_id: 'till-2', hub, label: 'Other Till' });
    const jwt = app.get(require('@nestjs/jwt').JwtService);
    const otherToken = jwt.sign({ sub: String(otherCashier), role: 'cashier', hubId: String(hub), deviceId: 'till-2' });
    const page = await api('/transactions', undefined, otherToken);
    assert.equal(page.status, 200, JSON.stringify(page.data)); assert.equal(page.data.data.length, 1);
    const detail = await api('/transactions/shared-location', undefined, otherToken);
    assert.equal(detail.data.actions.printReceipt, true); assert.equal(detail.data.actions.refund, false);
    assert.equal(detail.data.receipt.id, 'shared-location'); assert.equal(detail.data.locationId, String(hub));
    assert.equal(detail.data.receipt.origin.deviceLabel, undefined);
    assert.equal(detail.data.sale_payload, undefined); assert.equal(detail.data.account_snapshot, undefined);
    assert.equal((await api(`/checkouts/${row.id}/confirm-received`, { amountKobo: row.dueKobo, actualMethod: 'Cash', account: 'drawer', reason: 'test', confirmed: true }, otherToken)).status, 403);
    assert.equal((await api('/sales/shared-location/refund', { reversalId: 'forbidden-refund' }, otherToken)).status, 403);
    const foreignHub = new Types.ObjectId();
    await db.model('Hub').create({ _id: foreignHub, hub_name: 'Other location', is_active: true });
    await db.model('User').updateOne({ _id: otherCashier }, { hub: foreignHub });
    await db.model('PosDevice').updateOne({ device_id: 'till-2' }, { hub: foreignHub });
    const foreignToken = jwt.sign({ sub: String(otherCashier), role: 'cashier', hubId: String(foreignHub), deviceId: 'till-2' });
    assert.equal((await api('/transactions/shared-location', undefined, foreignToken)).status, 404);
    assert.equal((await api('/transactions', undefined, foreignToken)).data.data.length, 0);
    assert.equal(await db.model('Sale').countDocuments(), 1);
    assert.equal((await db.model('Product').findById(product)).current_stock, 8);
  });
  it('paginates and filters checkout history without duplicating its legacy sale records', async () => {
    const rows = Array.from({ length: 53 }, (_, index) => ({ client_sale_id: 'page-' + index, hub, device_id: 'till-1', cashier,
      customer, customer_name: index % 2 ? 'Ada' : 'Bola', kind: 'sale', mode: 'full_payment', total_kobo: 100,
      due_kobo: 100, status: 'awaiting', createdAt: new Date('2026-11-05T10:00:00Z') }));
    await db.model('PosCheckout').insertMany(rows);
    const page = await api('/transactions'); assert.equal(page.data.data.length, 50); assert.ok(page.data.nextCursor);
    const second = await api('/transactions?before=' + page.data.nextCursor); assert.equal(second.data.data.length, 3);
    assert.equal(new Set([...page.data.data, ...second.data.data].map(row => row.reference)).size, 53);
    const filtered = await api('/transactions?q=Ada&date=2026-11-05&status=awaiting');
    assert.equal(filtered.data.data.length, 26);
    assert.equal((await api('/transactions?before=invalid')).status, 400);
    assert.equal((await api('/transactions?q=.*')).data.data.length, 0);
    const pending = await api('/transactions/page-0'); assert.equal(pending.data.receipt, null);
  });
  it('records full and partial credit without treating debt as money received', async () => {
    const full = await create('full-credit', { paymentMode: 'full_credit', dueDate: '2099-01-01' }); assert.equal(full.status, 'completed');
    const partial = await create('partial-credit', { paymentMode: 'partial_credit', upfrontKobo: 8000, dueDate: '2099-01-01' });
    assert.equal((await manual(partial)).status, 201);
    const sale = await db.model('Sale').findOne({ client_sale_id: 'partial-credit' }); assert.equal(sale.amount_paid, 80); assert.equal(sale.status, 'Pending');
    assert.equal((await db.model('CreditRecord').findById(sale.credit_record)).amount_owed, 120);
    assert.equal(full.receipt.receiptPayment.paidKobo, 0);
    assert.equal((await db.model('Sale').findOne({ client_sale_id: 'full-credit' })).payment_type, undefined);
  });
  it('preserves another actual collection method without reporting it as cash', async () => {
    const row = await create('other-method');
    const result = await manual(row, { actualMethod: 'Other', account: 'Store voucher register' });
    assert.equal(result.status, 201);
    assert.equal(result.data.receipt.payments[0].method, 'Other');
    assert.equal((await db.model('Sale').findOne()).payment_type, 'Other');
  });
  it('repays existing credit without creating a sale or touching inventory and rejects over-allocation', async () => {
    await create('credit', { paymentMode: 'full_credit', dueDate: '2099-01-01' });
    const credit = await db.model('CreditRecord').findOne();
    const input = { clientSaleId: 'repayment', customerId: String(customer), creditId: String(credit._id), amountKobo: 5000 };
    const collection = await api('/credit-collections', input); assert.equal(collection.status, 201);
    assert.equal((await manual(collection.data)).status, 201); assert.equal((await manual(collection.data)).status, 201);
    assert.equal(await db.model('Sale').countDocuments(), 1); assert.equal((await db.model('Product').findById(product)).current_stock, 8);
    const current = await db.model('CreditRecord').findById(credit._id); assert.equal(current.amount_owed, 150); assert.equal(current.payments.length, 1);
    assert.equal((await api('/credit-collections', { ...input, clientSaleId: 'too-much', amountKobo: 15001 })).status, 400);
  });
  it('matches signed Moniepoint card and transfer events by reference, deduplicates and releases terminal locks', async () => {
    const row = await attempt(await create('terminal'));
    assert.equal(pushCalls, 1);
    await attempt(row); assert.equal(pushCalls, 1);
    assert.equal((await webhook(row.attempts[0], {}, false)).status, 400);
    assert.equal((await webhook(row.attempts[0])).status, 201); await webhook(row.attempts[0]); await service.tick();
    assert.equal((await api(`/checkouts/${row.id}`)).data.status, 'completed'); assert.equal(await db.model('Sale').countDocuments(), 1);
    assert.equal(await db.model('PosTerminalLock').countDocuments(), 0);
    assert.equal(await db.model('PosProviderTransaction').countDocuments(), 1);
    const card = await attempt(await create('terminal-card'), 'card-attempt', 'moniepoint', { method: 'card' });
    await webhook(card.attempts[0]); await service.tick();
    const completed = (await api(`/checkouts/${card.id}`)).data;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.receipt.payments[0].method, 'Card');
  });
  it('handles webhook-before-response and recovers payment status after worker restart', async () => {
    nextBehavior = 'early-webhook'; const row = await attempt(await create('early'));
    assert.equal(row.status, 'completed');
    const second = await attempt(await create('recover'));
    requests.get(second.attempts[0].reference).paid = true;
    const { CheckoutService } = require('../dist/pos/checkout.service'), { PosService } = require('../dist/pos/pos.service');
    const restarted = new CheckoutService(db, app.get(PosService), app.get('PSP_AUDIT'));
    await restarted.poll(await db.model('PosPaymentAttempt').findById(second.attempts[0].id));
    assert.equal((await api(`/checkouts/${second.id}`)).data.status, 'completed');
  });
  it('serializes duplicate provider clicks and refuses terminal contention across orders', async () => {
    const first = await create('first');
    const results = await Promise.all([attempt(first), attempt(first)]);
    assert.equal(results[0].attempts.length, 1); assert.equal(pushCalls, 1);
    const second = await create('second');
    const blocked = await api(`/checkouts/${second.id}/payment-attempts`, { clientAttemptId: 'different', provider: 'moniepoint', method: 'card' });
    assert.equal(blocked.status, 409); assert.equal(pushCalls, 1);
    process.env.MONIEPOINT_ENABLED = 'false';
    await webhook(results[0].attempts[0]); await service.tick();
    assert.equal((await api(`/checkouts/${first.id}`)).data.status, 'completed');
  });
  it('preserves credit refund accounting and returns the same amounts on retry', async () => {
    const checkout = await create('refund-credit', { paymentMode: 'partial_credit', upfrontKobo: 8000, dueDate: '2099-01-01' });
    await manual(checkout);
    const body = { reversalId: 'refund-one', total: -10000, lines: [{ productId: String(product), qty: 1, unitPrice: 10000, saleUnit: 'Units' }], payments: [{ method: 'Transfer', amount: -10000 }] };
    const first = await api('/sales/refund-credit/refund', body);
    assert.equal(first.status, 201, JSON.stringify(first.data));
    assert.equal(first.data.creditBalanceKobo, 2000); assert.equal(first.data.refundPaidKobo, 0);
    const retry = await api('/sales/refund-credit/refund', body);
    assert.equal(retry.data.creditBalanceKobo, 2000); assert.equal(retry.data.refundPaidKobo, 0);
    assert.equal(await db.model('Sale').countDocuments(), 2);
    assert.equal((await db.model('Product').findById(product)).current_stock, 9);
    const history = await api('/transactions/refund-credit');
    assert.equal(history.data.receipt.returnedQty[String(product)], 1);
  });
  it('finishes an existing Bachs transfer without allowing a new Bachs request', async () => {
    const pos = app.get(require('../dist/pos/pos.service').PosService);
    let reservation;
    await pos.inventoryTransaction(async () => {
      reservation = await pos.reservePayment(actor, draft('existing-bachs'));
      await db.model('PosTransfer').create({ client_sale_id: 'existing-bachs', checkout_id: 'legacy-account', provider: 'bachs', hub,
        device_id: 'till-1', cashier, cashier_name: 'Cashier', status: 'awaiting', reservation_state: 'held',
        cart_total_kobo: reservation.snapshot.total, payable_kobo: reservation.snapshot.total, priced_snapshot: reservation.snapshot,
        allocations: reservation.allocations, sale_payload: { ...draft('existing-bachs'), customerName: 'Buyer' } });
    });
    assert.equal((await api('/payments/transfers', { clientSaleId: 'existing-bachs' })).data.status, 'awaiting');
    assert.equal((await api('/payments/transfers', { ...draft('new-bachs'), provider: 'bachs' })).status, 409);
    await db.model('Hub').updateOne({ _id: hub }, { pos_manual_payment_confirmation: true });
    assert.equal((await api('/payments/transfers/existing-bachs/confirm-received', {})).status, 201);
    // Older transfers may predate stored priced snapshots; the saved sale remains printable.
    await db.model('PosTransfer').updateOne({ client_sale_id: 'existing-bachs' }, { $unset: { priced_snapshot: '' } });
    const history = await api('/transactions');
    assert.equal(history.data.data.length, 1); assert.equal(history.data.data[0].receipt.receiptPayment.provider, 'bachs');
    assert.equal(await db.model('Sale').countDocuments(), 1);
    assert.equal((await db.model('Product').findById(product)).current_stock, 8);
  });
  it('serializes CRM and POS repayments against the same ledger', async () => {
    require('../../fud-farmer-crm-be/node_modules/tsconfig-paths').register({ baseUrl: require('path').resolve(__dirname, '../../fud-farmer-crm-be/dist'), paths: { 'src/*': ['*'] } });
    const { CreditsService } = require('../../fud-farmer-crm-be/dist/credits/credits.service');
    const crm = new CreditsService(db.model('CreditRecord'), db.model('Customer'), db.model('Sale'), db,
      { fromRequest: () => ({ dataScope: 'all' }), canAccessCustomer: () => true });
    await create('credit-race', { paymentMode: 'full_credit', dueDate: '2099-01-01' });
    const credit = await db.model('CreditRecord').findOne();
    const repayment = await api('/credit-collections', { clientSaleId: 'pos-race', customerId: String(customer), creditId: String(credit._id), amountKobo: 15000 });
    const results = await Promise.allSettled([manual(repayment.data), crm.recordPayment(String(credit._id), { amount: 150, method: 'Cash' }, { _id: cashier, full_name: 'CRM cashier' })]);
    const latest = await db.model('CreditRecord').findById(credit._id);
    assert.equal(latest.amount_owed, 50); assert.equal(latest.payments.length, 1);
    assert.equal(await db.model('Sale').countDocuments(), 1);
    assert.ok(results.some(result => result.status === 'fulfilled'));
  });
  it('keeps timeout requests locked, permits manual fallback, and reviews later additional money', async () => {
    nextBehavior = 'timeout'; process.env.MONIEPOINT_HTTP_TIMEOUT_MS = '100';
    const row = await attempt(await create('timeout')); assert.equal(row.attempts[0].status, 'unknown');
    assert.equal((await api(`/checkouts/${row.id}/cancel`, {})).status, 409);
    assert.equal((await manual(row)).status, 201);
    assert.equal(await db.model('PosTerminalLock').countDocuments(), 1);
    await webhook(row.attempts[0]); await service.tick();
    assert.equal(await db.model('Sale').countDocuments(), 1);
    const reviews = await api('/checkouts/reviews', undefined, managerToken); assert.match(reviews.data.data[0].reason, /Additional payment/);
  });
  it('corroborates manual confirmation of the same attempt and does not count it twice', async () => {
    const row = await attempt(await create('corroborated'));
    assert.equal((await manual(row, { attemptId: row.attempts[0].id })).status, 201);
    await webhook(row.attempts[0]); await service.tick();
    assert.equal(await db.model('Sale').countDocuments(), 1); assert.equal(await db.model('PosWebhookInbox').countDocuments({ state: 'review' }), 0);
  });
  it('reviews wrong amounts and missing references rather than matching by amount or time', async () => {
    const row = await attempt(await create('mismatch'));
    await webhook(row.attempts[0], { amount: 1 }); await service.tick();
    assert.equal(await db.model('Sale').countDocuments(), 0);
    assert.ok(await db.model('PosWebhookInbox').exists({ state: 'review' }));
    await webhook(row.attempts[0], { merchantReference: null, transactionReference: 'unmatched-transaction' }); await service.tick();
    assert.equal(await db.model('Sale').countDocuments(), 0);
  });
  it('retains pending requests on server errors and does not accept a different terminal/business', async () => {
    nextBehavior = 'server-error'; const row = await attempt(await create('server-error'));
    assert.equal(row.attempts[0].status, 'unknown');
    assert.equal((await webhook(row.attempts[0], { businessId: 999 })).status, 400);
    await webhook(row.attempts[0], { terminalSerial: 'WRONG' }); await service.tick();
    assert.equal(await db.model('Sale').countDocuments(), 0);
  });
  it('offers manual collection with providers disabled and prevents old-client bypass', async () => {
    process.env.MONIEPOINT_ENABLED = 'false'; const options = await api('/checkouts/options');
    assert.equal(options.data.methods.find(m => m.id === 'manual').available, true);
    assert.equal(options.data.methods.find(m => m.id === 'moniepoint').available, false);
    assert.equal((await api('/sales', { ...draft('old'), hubId: String(hub), deviceId: 'till-1' })).status, 409);
    assert.equal((await api('/payments/transfers', draft('old-transfer'))).status, 409);
    assert.equal((await manual(await create('manual-disabled'))).status, 201);
  });
  it('uses Squad as an alternate PSP with separate customer charges and a signed webhook', async () => {
    const row = await attempt(await create('squad'), 'squad-attempt', 'squad'); const payment = row.attempts[0];
    assert.equal(payment.payableKobo, 20100);
    const response = await squadWebhook(payment);
    assert.equal(response.status, 201); await service.tick();
    const completed = (await api(`/checkouts/${row.id}`)).data;
    assert.equal(completed.status, 'completed'); assert.equal(completed.receipt.receiptPayment.feeKobo, 100);
    assert.equal((await db.model('Sale').findOne()).amount, 200);
    const audit = await db.collection('pos_psp_audit').find({ provider_id: 'squad' }).toArray();
    assert.ok(audit.some(row => row.stage === 'request_intent' && row.location_id === String(hub)));
    assert.ok(audit.some(row => row.stage === 'webhook_result' && row.verification_result === 'valid'));
    assert.ok(!JSON.stringify(audit).includes('sandbox_test'));
  });

  it('recovers verified webhooks and scheduled checks through BullMQ', {
    skip: !process.env.EVENT_TEST_REDIS_BINARY && 'set EVENT_TEST_REDIS_BINARY for real BullMQ coverage',
    timeout: 60_000,
  }, async () => {
    const { spawn } = require('node:child_process');
    const { once } = require('node:events');
    const { createServer } = require('node:net');
    const { setTimeout: delay } = require('node:timers/promises');
    const { Queue, Worker } = require('bullmq');
    const Redis = require('ioredis');
    const { PaymentReconciliationRelay, paymentReconciliationQueue, reconcilePaymentJob } = require('../dist/events/payment-reconciliation');
    const portProbe = createServer();
    await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const address = { host: '127.0.0.1', port: portProbe.address().port };
    await new Promise(resolve => portProbe.close(resolve));
    const redis = new Redis({ ...address, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    redis.on('error', () => {});
    const inbox = db.model('PosWebhookInbox');
    const attempts = db.model('PosPaymentAttempt');
    const originalUpdate = inbox.updateOne;
    const logs = [], originalLog = console.log, originalError = console.error;
    const secret = 'sensitive-error-text-must-not-leave-the-worker';
    console.log = value => logs.push(String(value)); console.error = value => logs.push(String(value));
    let redisServer, jobs, worker;
    const waitFor = async predicate => {
      for (let count = 0; count < 120; count++) {
        if (await predicate()) return;
        await delay(100);
      }
      assert.fail('Payment reconciliation did not reach the expected state');
    };
    const startWorker = async () => {
      worker = new Worker(paymentReconciliationQueue, job => reconcilePaymentJob(db, service, job), { connection: address, concurrency: 4 });
      worker.on('error', () => {});
      await worker.waitUntilReady();
    };
    process.env.POS_PAYMENT_RECONCILIATION_MODE = 'bullmq';
    try {
      const checkout = await attempt(await create('queued-webhook'));
      const payment = checkout.attempts[0];
      assert.equal((await webhook(payment, {}, false)).status, 400);
      assert.equal(await inbox.countDocuments(), 0);
      assert.equal((await webhook(payment)).status, 201);
      assert.equal((await webhook(payment)).status, 201);
      assert.equal(await inbox.countDocuments(), 1);
      const event = await inbox.findOne();
      assert.ok(await db.collection('pos_psp_audit').findOne({ exchange_id: event.correlation_id, stage: 'webhook_received' }));
      await service.tick();
      assert.equal((await api(`/checkouts/${checkout.id}?refresh=1`)).data.status, 'awaiting');
      assert.equal(await db.model('Sale').countDocuments(), 0);
      assert.equal(await db.collection('pos_psp_audit').countDocuments({ operation: 'status_lookup' }), 0);

      redisServer = spawn(process.env.EVENT_TEST_REDIS_BINARY,
        ['--bind', address.host, '--port', String(address.port), '--save', '', '--appendonly', 'no'],
        { stdio: 'ignore', windowsHide: true });
      await redis.connect().catch(() => undefined);
      await waitFor(() => redis.status === 'ready');
      jobs = new Queue(paymentReconciliationQueue, { connection: redis });
      jobs.on('error', () => {});
      let relay = new PaymentReconciliationRelay(db, jobs);
      const jobId = `payment.webhook.received.v1-${event._id}-0`;
      await relay.dispatch();
      assert.deepEqual((await jobs.getJob(jobId)).data, { recordId: String(event._id) });
      await jobs.obliterate({ force: true }); // Redis lost jobs before any worker could consume them.
      assert.equal(await jobs.getJob(jobId), undefined);
      relay = new PaymentReconciliationRelay(db, jobs);
      await relay.dispatch();
      assert.ok(await jobs.getJob(jobId));

      // The financial commit succeeds, but the inbox acknowledgement and retry update both fail.
      inbox.updateOne = function (filter, ...args) {
        if (String(filter._id) === String(event._id) && filter.lease_owner) throw new Error(secret);
        return originalUpdate.call(this, filter, ...args);
      };
      await startWorker();
      await waitFor(async () => (await jobs.getJob(jobId))?.failedReason === 'reconciliation_error');
      assert.equal(await db.model('Sale').countDocuments(), 1);
      assert.equal((await inbox.findById(event._id)).state, 'pending');
      assert.ok(!JSON.stringify((await jobs.getJob(jobId)).stacktrace).includes(secret));
      await worker.close(); worker = undefined;
      inbox.updateOne = originalUpdate;
      await inbox.updateOne({ _id: event._id }, { $set: { lease_until: new Date(Date.now() - 1) } });
      await startWorker();
      await relay.dispatch();
      await waitFor(async () => (await inbox.findById(event._id)).state === 'done');
      assert.equal(await db.model('Sale').countDocuments(), 1);
      assert.equal(await db.model('PosProviderTransaction').countDocuments(), 1);
      assert.equal((await db.model('Product').findById(product)).current_stock, 8);

      const squad = await attempt(await create('queued-squad-race'), 'squad', 'squad');
      const squadPayment = squad.attempts[0];
      assert.equal((await squadWebhook(squadPayment)).status, 201);
      const manualResult = manual(squad, { attemptId: squadPayment.id, amountKobo: squadPayment.payableKobo });
      await relay.dispatch();
      assert.equal((await manualResult).status, 201);
      await waitFor(async () => (await inbox.findOne({ provider: 'squad' }))?.state === 'done');
      assert.equal(await db.model('Sale').countDocuments(), 2);
      assert.equal(await db.model('PosProviderTransaction').countDocuments(), 2);
      assert.equal((await db.model('Product').findById(product)).current_stock, 6);

      const byStatus = await attempt(await create('queued-status-only'));
      const statusPayment = byStatus.attempts[0];
      requests.get(statusPayment.reference).paid = true;
      const due = new Date(Date.now() + 1000);
      await attempts.updateOne({ _id: statusPayment.id }, { $set: { next_check: due } });
      await relay.dispatch();
      const statusJobId = `payment.status.check.v1-${statusPayment.id}-${due.getTime()}`;
      const statusJob = await jobs.getJob(statusJobId);
      assert.equal(await statusJob.getState(), 'delayed');
      assert.deepEqual(statusJob.data, { recordId: statusPayment.id });
      await waitFor(async () => (await db.model('PosCheckout').findById(byStatus.id)).status === 'completed');
      assert.ok(await db.collection('pos_psp_audit').findOne({ correlation_id: statusPayment.id, operation: 'status_lookup', stage: 'http_response' }));
      assert.equal(await db.model('Sale').countDocuments(), 3);
      const trace = logs.map(line => JSON.parse(line)).filter(line => line.correlationId === event.correlation_id);
      assert.ok(trace.some(line => line.action === 'payment_webhook_persisted'));
      assert.ok(trace.some(line => line.action === 'payment_reconciliation_failed'));
      assert.ok(trace.some(line => line.action === 'payment_reconciliation_done'));
      assert.ok(!logs.join('\n').includes(secret));
    } finally {
      inbox.updateOne = originalUpdate;
      if (worker) await worker.close();
      redis.disconnect();
      if (jobs) await jobs.close();
      if (redisServer && redisServer.exitCode === null) {
        const exited = once(redisServer, 'exit'); redisServer.kill(); await exited;
      }
      process.env.POS_PAYMENT_RECONCILIATION_MODE = 'legacy';
      console.log = originalLog; console.error = originalError;
    }
  });

  it('fences stale poll writes after a replacement poll takes ownership', async () => {
    const { MoniepointClient } = require('../dist/pos/moniepoint.client');
    const originalCheck = MoniepointClient.prototype.check;
    const row = await attempt(await create('stale-poll'));
    const payment = row.attempts[0];
    const model = db.model('PosPaymentAttempt');
    const evidence = { reference: payment.reference, terminalSerial: 'SERIAL-1', businessOwnerId: '101', currency: 'NGN', method: 'Transfer' };
    try {
      for (const lateResult of [
        () => ({ ...evidence, status: 'failed' }),
        () => { throw new Error('The original poll transport failed'); },
        () => ({ ...evidence, status: 'review', amountKobo: 1 }),
      ]) {
        let started, resume;
        const began = new Promise(resolve => { started = resolve; });
        const stalled = new Promise(resolve => { resume = resolve; });
        let calls = 0;
        MoniepointClient.prototype.check = async () => {
          if (++calls === 1) { started(); await stalled; return lateResult(); }
          return { ...evidence, status: 'pending' };
        };
        const oldPoll = service.poll(await model.findById(payment.id), payment.id);
        await began;
        try {
          await model.updateOne({ _id: payment.id }, { $set: { lease_until: new Date(Date.now() - 1) } });
          assert.equal(await service.poll(await model.findById(payment.id), payment.id), 'checked');
          const replacement = await model.findById(payment.id);
          resume();
          assert.equal(await oldPoll, 'stale');
          const actual = await model.findById(payment.id);
          assert.equal(actual.next_check.getTime(), replacement.next_check.getTime());
          assert.equal(actual.status, 'pending');
          assert.equal(actual.failures, 0);
          assert.equal(await db.model('PosTerminalLock').countDocuments(), 1);
          assert.equal(await db.model('PosWebhookInbox').countDocuments(), 0);
          assert.equal(await db.model('Sale').countDocuments(), 0);
        } finally {
          resume();
          await oldPoll;
        }
      }
      MoniepointClient.prototype.check = async () => {
        await model.updateOne({ _id: payment.id }, { $set: { lease_until: new Date(Date.now() - 1) } });
        return { ...evidence, status: 'paid', amountKobo: payment.payableKobo, transactionReference: 'valid-late-payment' };
      };
      await service.poll(await model.findById(payment.id), payment.id);
      assert.equal((await model.findById(payment.id)).status, 'paid');
      assert.equal(await db.model('PosTerminalLock').countDocuments(), 0);
      assert.equal(await db.model('Sale').countDocuments(), 1);
    } finally {
      MoniepointClient.prototype.check = originalCheck;
    }
  });

  it('does not release a terminal when a stale provider dispatch returns a definite error', async () => {
    const { MoniepointClient } = require('../dist/pos/moniepoint.client');
    const { ProviderFailure } = require('../dist/pos/payment-provider');
    const originalOpen = MoniepointClient.prototype.open, originalCheck = MoniepointClient.prototype.check;
    let started, resume;
    const began = new Promise(resolve => { started = resolve; });
    const stalled = new Promise(resolve => { resume = resolve; });
    const model = db.model('PosPaymentAttempt');
    let opening;
    try {
      const row = await create('stale-dispatch');
      MoniepointClient.prototype.open = async () => {
        started(); await stalled; throw new ProviderFailure('Old request returned a definite error', true);
      };
      MoniepointClient.prototype.check = async reference => ({
        reference, terminalSerial: 'SERIAL-1', businessOwnerId: '101', status: 'pending',
      });
      opening = attempt(row);
      await began;
      const pending = await model.findOne({ checkout: row.id });
      await model.updateOne({ _id: pending._id }, { $set: { lease_until: new Date(Date.now() - 1) } });
      assert.equal(await service.poll(await model.findById(pending._id), String(pending._id)), 'checked');
      const scheduled = (await model.findById(pending._id)).next_check;
      resume();
      const result = await opening;
      assert.equal(result.attempts[0].status, 'pending');
      assert.equal((await model.findById(pending._id)).next_check.getTime(), scheduled.getTime());
      assert.equal(await db.model('PosTerminalLock').countDocuments(), 1);
      assert.equal(await db.model('Sale').countDocuments(), 0);
    } finally {
      resume();
      await opening;
      MoniepointClient.prototype.open = originalOpen;
      MoniepointClient.prototype.check = originalCheck;
    }
  });

  it('keeps verified Squad instructions from the original request after its lease expires', async () => {
    const { SquadClient } = require('../dist/pos/squad.client');
    const originalOpen = SquadClient.prototype.open;
    let started, resume;
    const began = new Promise(resolve => { started = resolve; });
    const stalled = new Promise(resolve => { resume = resolve; });
    const model = db.model('PosPaymentAttempt');
    let opening;
    try {
      const row = await create('late-squad-instructions');
      SquadClient.prototype.open = async function (...args) {
        const instructions = await originalOpen.apply(this, args);
        started(); await stalled;
        return instructions;
      };
      opening = attempt(row, 'late-squad', 'squad');
      await began;
      const pending = await model.findOne({ checkout: row.id });
      await model.updateOne({ _id: pending._id }, { $set: { lease_until: new Date(Date.now() - 1) } });
      assert.equal(await service.poll(await model.findById(pending._id), String(pending._id)), 'checked');
      const scheduled = (await model.findById(pending._id)).next_check;
      resume();
      const result = await opening;
      assert.equal(result.attempts[0].status, 'pending');
      assert.equal(result.attempts[0].payableKobo, 20100);
      assert.equal(result.attempts[0].feeKobo, 100);
      assert.equal((await model.findById(pending._id)).next_check.getTime(), scheduled.getTime());
      assert.equal((await squadWebhook(result.attempts[0])).status, 201);
      await service.tick();
      assert.equal(await db.model('Sale').countDocuments(), 1);
    } finally {
      resume();
      await opening;
      SquadClient.prototype.open = originalOpen;
    }
  });

  it('audits requests, each webhook retry and rejection without duplicate sales; restricts reads to managers', async () => {
    const row = await attempt(await create('audit-evidence')), payment = row.attempts[0];
    const outbound = await db.collection('pos_psp_audit').find({ direction: 'outbound' }).toArray();
    assert.equal(outbound.length, 2);
    assert.equal(outbound[0].merchant_reference, payment.reference);
    assert.equal(outbound[0].provider_id, 'moniepoint'); assert.equal(outbound[0].account_key, 'lagos');
    assert.equal(outbound[0].amount_kobo, row.dueKobo); assert.equal(outbound[0].location_id, String(hub));
    assert.equal(outbound[0].exchange_id, outbound[1].exchange_id); assert.equal(outbound[1].http_status, 202);
    assert.equal((await webhook(payment, {}, false)).status, 400);
    assert.equal((await webhook(payment)).status, 201); assert.equal((await webhook(payment)).status, 201);
    await service.tick(); assert.equal(await db.model('Sale').countDocuments(), 1);
    const inbound = await db.collection('pos_psp_audit').find({ direction: 'inbound' }).toArray();
    assert.equal(inbound.filter(row => row.stage === 'webhook_received').length, 3);
    assert.equal(inbound.filter(row => row.stage === 'webhook_result' && row.verification_result === 'valid').length, 2);
    assert.ok(inbound.some(row => row.verification_result === 'invalid_signature_or_business' && !row.location_id));
    const serialized = JSON.stringify([...outbound, ...inbound]);
    assert.ok(!serialized.includes('test-webhook-secret')); assert.ok(!serialized.includes('test-key'));
    assert.equal((await api('/payment-audit')).status, 403);
    await app.get('PSP_AUDIT').append({ exchange_id: 'foreign', provider_id: 'squad', location_id: String(new Types.ObjectId()), stage: 'test' });
    const page = await api('/payment-audit', undefined, managerToken);
    assert.equal(page.status, 200); assert.ok(page.data.data.length > 0);
    assert.ok(page.data.data.every(item => item.location_id === String(hub)));
    assert.equal((await api('/payment-audit?provider=invalid', undefined, managerToken)).status, 400);
    const indexes = await db.collection('pos_psp_audit').indexes();
    assert.ok(indexes.every(index => index.expireAfterSeconds === undefined));
    await assert.rejects(db.model('PspAudit').updateOne({}, { $set: { stage: 'modified' } }), /append-only/);
  });

  it('keeps audit writes outside payment transaction rollback and records parser rejections', async () => {
    await assert.rejects(db.transaction(async () => {
      await app.get('PSP_AUDIT').append({ exchange_id: 'rollback-proof', provider_id: 'moniepoint', stage: 'test' });
      throw new Error('force rollback');
    }), /force rollback/);
    assert.ok(await db.collection('pos_psp_audit').findOne({ exchange_id: 'rollback-proof' }));
    const raw = '{"broken":';
    const response = await fetch(base + '/pos/webhooks/moniepoint/lagos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
    assert.equal(response.status, 400);
    const rejected = await db.collection('pos_psp_audit').findOne({ outcome: 'parser_rejected' });
    assert.ok(rejected); assert.equal(rejected.body_sha256, crypto.createHash('sha256').update(raw).digest('hex'));
    assert.equal(rejected.payload_format, 'non_json');
  });

  it('prevents unaudited provider requests and keeps an uncertain response locked', async () => {
    const audit = app.get('PSP_AUDIT'), append = audit.append.bind(audit);
    audit.append = async () => { throw new Error('storage unavailable'); };
    try {
      const row = await attempt(await create('audit-offline'));
      assert.equal(pushCalls, 0); assert.equal(row.attempts[0].status, 'failed');
      assert.equal(await db.model('PosTerminalLock').countDocuments(), 0);
    } finally { audit.append = append; }
    audit.append = async record => { if (record.stage === 'http_response') throw new Error('storage unavailable'); return append(record); };
    try {
      const row = await attempt(await create('audit-result-offline'));
      assert.equal(pushCalls, 1); assert.equal(row.attempts[0].status, 'unknown');
      assert.equal(await db.model('PosTerminalLock').countDocuments(), 1);
      assert.equal(await db.model('Sale').countDocuments(), 0);
    } finally { audit.append = append; }
  });

  it('does not acknowledge an unaudited webhook and safely accepts its later retry', async () => {
    const row = await attempt(await create('webhook-audit-offline')), payment = row.attempts[0];
    const audit = app.get('PSP_AUDIT'), append = audit.append.bind(audit);
    audit.append = async record => { if (record.stage === 'webhook_received') throw new Error('storage offline'); return append(record); };
    try { assert.equal((await webhook(payment)).status, 503); assert.equal(await db.model('PosWebhookInbox').countDocuments(), 0); }
    finally { audit.append = append; }
    audit.append = async record => { if (record.stage === 'webhook_result') throw new Error('storage offline'); return append(record); };
    try { assert.equal((await webhook(payment)).status, 503); assert.equal(await db.model('PosWebhookInbox').countDocuments(), 1); }
    finally { audit.append = append; }
    assert.equal((await webhook(payment)).status, 201); await service.tick();
    assert.equal(await db.model('Sale').countDocuments(), 1);
  });

  it('retains verified historical Bachs deliveries with their provider and exact body hash', async () => {
    process.env.BACHS_API_KEY = 'sk_sandbox_audit'; process.env.BACHS_WEBHOOK_SECRET = 'bachs-audit-secret';
    try {
      const raw = JSON.stringify({ id: 'legacy-event', type: 'collection.succeeded', data: { checkout_id: 'unknown-legacy', amount: '100.00', currency: 'NGN', status: 'paid' } });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto.createHmac('sha256', 'bachs-audit-secret').update(`${timestamp}.${raw}`).digest('hex');
      const response = await fetch(base + '/pos/webhooks/bachs', { method: 'POST', body: raw,
        headers: { 'Content-Type': 'application/json', 'x-bachs-timestamp': timestamp, 'x-bachs-signature': signature } });
      assert.equal(response.status, 201);
      const record = await db.collection('pos_psp_audit').findOne({ provider_id: 'bachs', stage: 'webhook_result' });
      assert.equal(record.verification_result, 'valid'); assert.equal(record.merchant_reference, 'unknown-legacy');
      assert.equal(record.body_sha256, crypto.createHash('sha256').update(raw).digest('hex'));
      assert.equal(await db.model('Sale').countDocuments(), 0);
    } finally { delete process.env.BACHS_API_KEY; delete process.env.BACHS_WEBHOOK_SECRET; }
  });
});
