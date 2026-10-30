export type FifoBatch = { id: string; batchNumber: string; date: Date | string; createdAt?: Date | string; quantityRemaining: number; unitCost: number };
export type FifoAllocation = { batch_number: string; quantity: number; unit_cost: number; stock_log_id: string };

/** Receipt date, creation time, then ID. Expiry dates never change FIFO order. */
export function allocateFifo(rows: FifoBatch[], quantity: number, reserved: Record<string, number> = {}): FifoAllocation[] {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Quantity must be greater than zero');
  const time = (date: Date | string | undefined) => date ? new Date(date).getTime() || 0 : 0;
  const ordered = [...rows].sort((a, b) => time(a.date) - time(b.date) || time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id));
  const held = { ...reserved };
  const result: FifoAllocation[] = [];
  let remaining = quantity;
  for (const batch of ordered) {
    const key = Buffer.from(batch.batchNumber).toString('hex');
    const unavailable = Math.min(Math.max(0, Number(held[key]) || 0), Math.max(0, batch.quantityRemaining));
    held[key] = Math.max(0, (held[key] || 0) - unavailable);
    const available = Math.max(0, batch.quantityRemaining - unavailable);
    const take = Math.min(remaining, available);
    if (take > 1e-9) result.push({ batch_number: batch.batchNumber, quantity: take, unit_cost: batch.unitCost, stock_log_id: batch.id });
    remaining -= take;
    if (remaining <= 1e-9) return result;
  }
  throw new Error('Insufficient available stock for this sale');
}
