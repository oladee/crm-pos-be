import { allocateFifo } from './fifo';

describe('FIFO stock allocation', () => {
  const older = { id: 'a', batchNumber: 'old', date: '2026-01-01', quantityRemaining: 3, unitCost: 10, expiryDate: '2027-01-01' };
  const newer = { id: 'b', batchNumber: 'new', date: '2026-02-01', quantityRemaining: 5, unitCost: 20, expiryDate: '2026-03-01' };
  it('uses receipt order rather than expiry and spans batches with original costs', () => {
    expect(allocateFifo([newer, older], 5)).toEqual([
      { batch_number: 'old', quantity: 3, unit_cost: 10, stock_log_id: 'a' },
      { batch_number: 'new', quantity: 2, unit_cost: 20, stock_log_id: 'b' },
    ]);
  });
  it('skips stock reserved by another pending payment', () => {
    const allocations = allocateFifo([older, newer], 3, { [Buffer.from('old').toString('hex')]: 2 });
    expect(allocations.map(row => row.quantity)).toEqual([1, 2]);
  });
  it('does not mutate balances and refuses insufficient stock', () => {
    expect(() => allocateFifo([older, newer], 9)).toThrow(/Insufficient/);
    expect(older.quantityRemaining).toBe(3);
  });
  it('uses stable ID order when receipt dates match', () => {
    expect(allocateFifo([{ ...older, id: 'b' }, { ...older, id: 'a' }], 1)[0].stock_log_id).toBe('a');
  });
  it('supports fractional stock quantities and rejects invalid amounts', () => {
    expect(allocateFifo([older], 0.25)[0].quantity).toBe(0.25);
    expect(() => allocateFifo([older], NaN)).toThrow(/Quantity/);
  });
});
