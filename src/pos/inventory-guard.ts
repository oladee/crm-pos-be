import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Schema } from 'mongoose';

export function inventorySession(model: any, explicit?: any) {
  return explicit || model.base.transactionAsyncLocalStorage?.getStore()?.session;
}

/** All services sharing products must take this write fence before checking availability. */
export async function fenceProduct(model: any, id: any, session?: any) {
  session = inventorySession(model, session);
  if (!session) throw new ServiceUnavailableException('Inventory writes require a MongoDB transaction.');
  return model.collection.findOneAndUpdate({ _id: id }, { $inc: { inventory_version: 1 } },
    { session, returnDocument: 'after' });
}

export function productInventoryGuard(schema: Schema) {
  schema.add({ reserved_stock: { type: Number, default: 0 }, reserved_batches: { type: Schema.Types.Mixed, default: {} }, inventory_version: { type: Number, default: 0 } });
  schema.pre('save', async function(this: any) {
    if (this.isNew) return;
    const session = inventorySession(this.constructor, this.$session());
    const current = await fenceProduct(this.constructor, this._id, session);
    if (!current) return;
    if (current.reserved_stock && ['hub', 'unit_of_measure', 'carton_weight'].some(field => this.isModified(field))) {
      throw new ConflictException('Resolve reserved payments before changing the product location or stock units.');
    }
    if (this.isModified('current_stock') && Number(this.current_stock) + 1e-8 < Number(current.reserved_stock || 0)) {
      throw new ConflictException('This stock is reserved for an unresolved payment. Confirm or cancel that payment first.');
    }
  });
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as any, async function(this: any) {
    const session = inventorySession(this.model, this.getOptions().session);
    const rows = await this.model.find(this.getFilter()).session(session).lean();
    const update = this.getUpdate() || {};
    for (const row of rows.sort((a: any, b: any) => String(a._id).localeCompare(String(b._id)))) {
      const current = await fenceProduct(this.model, row._id, session);
      const reserved = Number(current?.reserved_stock || 0);
      if (!reserved) continue;
      const stockOperators = Object.keys(update).filter(key => key.startsWith('$') && !['$set', '$inc', '$setOnInsert'].includes(key));
      if (stockOperators.some(key => Object.keys(update[key] || {}).some(field => ['current_stock', 'hub', 'unit_of_measure', 'carton_weight'].includes(field))) || update.$rename) {
        throw new ConflictException('This stock operation is not supported while payment reservations exist.');
      }
      if (['hub', 'unit_of_measure', 'carton_weight'].some(field => update.$set?.[field] !== undefined || update[field] !== undefined || update.$unset?.[field] !== undefined || update.$rename?.[field] !== undefined)) {
        throw new ConflictException('Resolve reserved payments before changing the product location or stock units.');
      }
      if (Array.isArray(update) || /delete|replace/i.test(this.op) || update.$unset?.current_stock != null || update.$rename?.current_stock != null) {
        throw new ConflictException('Cannot remove or replace stock with unresolved payment reservations.');
      }
      const next = Object.hasOwn(update.$set || {}, 'current_stock') ? update.$set.current_stock
        : Object.hasOwn(update, 'current_stock') ? update.current_stock
        : update.$inc?.current_stock != null ? Number(current.current_stock || 0) + Number(update.$inc.current_stock) : current.current_stock;
      if (next == null || !Number.isFinite(Number(next)) || Number(next) + 1e-8 < reserved) throw new ConflictException('Available stock excludes quantities reserved for unresolved payments.');
    }
  });
  // Existing bulk import paths bypass document/query hooks. Fail closed while holds exist.
  schema.pre('bulkWrite' as any, async function(this: any, _operations: any, options: any) {
    const session = inventorySession(this, options?.session);
    for (const row of await this.find().sort({ _id: 1 }).session(session).lean()) {
      const current = await fenceProduct(this, row._id, session);
      if (current?.reserved_stock) throw new ConflictException('Finish unresolved payments before running a bulk stock import.');
    }
  });
}

export function stockLogInventoryGuard(schema: Schema) {
  schema.pre('save', async function(this: any) {
    const products = this.db.model('Product');
    const session = inventorySession(products, this.$session());
    const product = await fenceProduct(products, this.item, session);
    if (!product?.reserved_stock) return;
    // Changing historical batch records can invalidate allocations. Use a compensating entry.
    if (!this.isNew) {
      if (this.modifiedPaths().every((field: string) => ['quantity_remaining', 'updatedAt', '__v'].includes(field))) {
        await assertRemainingBalance(this.constructor, this, Number(this.quantity_remaining), product, session); return;
      }
      throw new ConflictException('Cannot edit batch history while stock is reserved.');
    }
    const outbound = this.type === 'SALE' || Number(this.quantity) < 0;
    if (!outbound) return;
    const batch = String(this.batch_number || '').trim();
    const held = product.reserved_batches || {};
    const batchKey = Buffer.from(batch).toString('hex');
    if (!batch) throw new ConflictException('Select a batch while payment reservations exist.');
    if (Number(held[batchKey] || 0) > 0) {
      const logs = await this.constructor.find({ item: this.item }).sort({ date: 1, createdAt: 1, _id: 1 }).session(session).lean();
      const available = batchBalance(logs, batch) - Number(held[batchKey]);
      if (Math.abs(Number(this.quantity)) > available + 1e-8) throw new ConflictException('This quantity is reserved for an unresolved payment.');
    }
  });
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as any, async function(this: any) {
    const session = inventorySession(this.model, this.getOptions().session);
    const rows = await this.model.find(this.getFilter()).session(session).lean();
    for (const row of rows) {
      const product = await fenceProduct(this.model.db.model('Product'), row.item, session);
      if (product?.reserved_stock) {
        const update = this.getUpdate() || {};
        if (rows.length === 1 && this.op === 'updateOne' && Object.keys(update).every(key => ['$set', '$setOnInsert'].includes(key))
          && Object.keys(update.$set || {}).every(key => ['quantity_remaining', 'updatedAt'].includes(key)) && update.$set?.quantity_remaining != null) {
          await assertRemainingBalance(this.model, row, Number(update.$set.quantity_remaining), product, session);
        } else throw new ConflictException('Cannot rewrite batch history while stock is reserved.');
      }
    }
  });
  schema.pre(['insertMany', 'bulkWrite'] as any, async function(this: any, _operations: any, options: any) {
    const products = this.db.model('Product');
    const session = inventorySession(this, options?.session);
    for (const row of await products.find().sort({ _id: 1 }).session(session).lean()) {
      const current = await fenceProduct(products, row._id, session);
      if (current?.reserved_stock) throw new ConflictException('Finish unresolved payments before running bulk inventory operations.');
    }
  });
}

// Replay the stock ledger with the same expiry-first allocation used by POS.
export function batchBalance(logs: any[], target: string): number {
  const batches: Array<{ code: string; remaining: number; date: number; expiry: number }> = [];
  for (const log of logs) {
    const quantity = Math.abs(Number(log.quantity) || 0);
    const inbound = ['PURCHASE', 'RETURN'].includes(log.type) || (['TRANSFER', 'ADJUSTMENT'].includes(log.type) && Number(log.quantity) > 0);
    const outbound = log.type === 'SALE' || (['TRANSFER', 'ADJUSTMENT'].includes(log.type) && Number(log.quantity) < 0);
    const code = String(log.batch_number || '').trim();
    if (inbound) batches.push({ code, remaining: quantity, date: new Date(log.date || 0).getTime(), expiry: log.expiry_date ? new Date(log.expiry_date).getTime() : Infinity });
    else if (outbound) {
      let left = quantity;
      for (const b of [...batches].sort((a, b) => a.date - b.date)) {
        if (code && b.code !== code) continue;
        const used = Math.min(left, b.remaining); b.remaining -= used; left -= used;
        if (left <= 0) break;
      }
    }
  }
  return batches.filter(b => b.code === target).reduce((sum, b) => sum + b.remaining, 0);
}

async function assertRemainingBalance(model: any, row: any, next: number, product: any, session: any) {
  if (!Number.isFinite(next) || next < 0) throw new ConflictException('Invalid batch balance');
  const others = await model.find({ item: row.item, batch_number: row.batch_number, _id: { $ne: row._id }, quantity_remaining: { $exists: true } }).session(session).lean();
  const total = next + others.reduce((sum: number, log: any) => sum + Number(log.quantity_remaining || 0), 0);
  const held = Number(product.reserved_batches?.[Buffer.from(String(row.batch_number || '')).toString('hex')] || 0);
  if (total + 1e-8 < held) throw new ConflictException('Cannot consume stock held for an unresolved payment');
}
