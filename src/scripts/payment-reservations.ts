import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PosService } from '../pos/pos.service';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const db = app.get<Connection>(getConnectionToken());
    const pos = app.get(PosService);
    const transfers = db.model('PosTransfer');
    const marker = db.collection('pos_payment_rollout');
    const apply = process.argv.includes('--apply');
    const hello = await db.db!.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('A replica set or sharded MongoDB cluster is required. No non-transactional fallback is supported.');
    const pending = await transfers.find({ status: { $in: ['initializing', 'awaiting', 'expired', 'review'] }, reservation_state: { $nin: ['held', 'consumed', 'released'] } });
    if (!apply) {
      console.log(JSON.stringify({ mode: 'dry-run', transactionsSupported: true, legacyUnresolved: pending.length,
        ready: (await marker.findOne({ _id: 'reservations-v1' as any }))?.ready === true }));
      return;
    }
    if (process.env.CRM_RESERVATION_GUARDS_DEPLOYED !== 'true') throw new Error('Deploy the CRM inventory guards and set CRM_RESERVATION_GUARDS_DEPLOYED=true before backfill.');
    await marker.updateOne({ _id: 'reservations-v1' as any }, { $set: { ready: false, startedAt: new Date() } }, { upsert: true });
    let held = 0, flagged = 0;
    for (const legacy of pending) {
      try {
        await pos.inventoryTransaction(async () => {
          const row = await transfers.findOneAndUpdate({ _id: legacy._id }, { $inc: { __v: 1 } }, { new: true });
          if (!row || row.reservation_state === 'held' || ['paid', 'cancelled'].includes(row.status)) return;
          const sale = await db.model('Sale').findOne({ client_sale_id: row.client_sale_id });
          if (sale) { row.status = 'paid'; row.reservation_state = 'consumed'; await row.save(); return; }
          const result = await pos.reservePayment({ sub: String(row.cashier), role: 'cashier', hubId: String(row.hub), deviceId: row.device_id }, row.sale_payload);
          if (Math.abs(result.snapshot.total - row.cart_total_kobo) > 1) throw new Error('Historical sale total differs from current prices; manager reconciliation required');
          row.allocations = result.allocations; row.priced_snapshot = result.snapshot; row.reservation_state = 'held';
          row.provider = row.provider || 'bachs'; row.fee_kobo = Math.max(0, row.payable_kobo - row.cart_total_kobo);
          row.reconciliation_reason = undefined; await row.save();
        });
        held++;
      } catch (error) {
        flagged++;
        await transfers.updateOne({ _id: legacy._id, reservation_state: { $ne: 'held' } }, { $set: {
          reservation_state: 'needs_review', reconciliation_reason: error instanceof Error ? error.message : 'Backfill failed',
        } });
      }
    }
    const unresolved = await transfers.countDocuments({ status: { $in: ['initializing', 'awaiting', 'expired', 'review'] }, reservation_state: { $ne: 'held' } });
    // This write also proves that the deployment can commit transactions.
    await db.transaction(async session => {
      await marker.updateOne({ _id: 'reservations-v1' as any }, { $set: { ready: unresolved === 0, checkedAt: new Date(), unresolved } }, { session });
    });
    console.log(JSON.stringify({ mode: 'apply', backfilled: held, flagged, unresolved, ready: unresolved === 0 }));
    if (unresolved) process.exitCode = 1;
  } finally { await app.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
