import { PosTransferService } from './pos-transfer.service';
import { PosJwtPayload } from './pos-auth';

// These tests exercise response/scoping logic without booting Mongoose or Nest DI.
jest.mock('@nestjs/mongoose', () => ({ InjectModel: () => () => undefined }));
jest.mock('./pos.service', () => ({ PosService: class {} }));

describe('transfer receipt response and recovery scope', () => {
  const actor = { sub: 'cashier-1', hubId: 'hub-1', role: 'cashier', deviceId: 'till-1' } as PosJwtPayload;
  let service: PosTransferService;
  let find: jest.Mock;

  beforeEach(() => {
    find = jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });
    const hubs = { findById: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ is_active: true }) }) };
    const users = { findById: jest.fn().mockReturnValue({ populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ is_active: true, hub: 'hub-1', role: { name: 'cashier' } }) }) }) };
    service = new PosTransferService({ find } as any, {} as any, hubs as any, users as any, {} as any);
  });

  it('serializes confirmation time and supports older records', async () => {
    const confirmed_at = new Date('2026-10-31T09:05:00Z');
    const row = { status: 'paid', confirmed_at };
    expect((await (service as any).view(row)).confirmedAt).toBe(confirmed_at.toISOString());
    expect((await (service as any).view({ status: 'awaiting' })).confirmedAt).toBeNull();
  });

  it('recovers paid receipts only for the authenticated till and cashier', async () => {
    await service.list(actor, 'attacker-controlled-till', true);
    expect(find).toHaveBeenCalledWith({
      hub: 'hub-1', cashier: 'cashier-1',
      $or: [
        { status: { $in: ['initializing', 'awaiting', 'expired', 'review'] } },
        { status: 'paid', device_id: 'till-1' },
      ],
    });
  });

  it('keeps paid records out of the default list', async () => {
    await service.list(actor);
    expect(find.mock.calls[0][0].status.$in).not.toContain('paid');
  });

  it('does not recover paid records for a session without a till', async () => {
    await service.list({ ...actor, deviceId: undefined }, 'till-1', true);
    expect(find.mock.calls[0][0].status.$in).not.toContain('paid');
  });
});
