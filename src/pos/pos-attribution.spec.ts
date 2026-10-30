jest.mock('@nestjs/mongoose', () => ({ InjectModel: () => () => undefined }));
jest.mock('@nestjs/jwt', () => ({ JwtService: class {} }));
jest.mock('./pos-passkey.service', () => ({ PosPasskeyService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import { PosService } from './pos.service';
import type { PosJwtPayload } from './pos-auth';

describe('authenticated till attribution', () => {
  const hub = '000000000000000000000001';
  const user: PosJwtPayload = {
    sub: '000000000000000000000002',
    role: 'cashier',
    hubId: hub,
    deviceId: 'till-A',
  };
  let service: PosService;
  let state: any;
  beforeEach(() => {
    // Exercise the real sale/reversal methods, with storage and pricing kept in memory.
    service = Object.create(PosService.prototype);
    state = service as any;
    state.inventoryTransaction = jest.fn(work => work());
    state.lockPaymentProducts = jest.fn().mockResolvedValue(undefined);
    state.productModel = { db: { model: () => ({ exists: async () => null }) } };
    state.deviceModel = {
      findOne: jest.fn().mockResolvedValue({ hub, save: jest.fn() }),
    };
    state.saleModel = {
      findOne: jest.fn(() => ({ lean: async () => null })),
      create: jest.fn(async (sale) => sale),
    };
    state.priceCart = jest.fn().mockResolvedValue({ total: 12345, lines: [] });
  });

  it('records the session device and converts kobo to naira', async () => {
    const result = await service.createSale(user, { clientSaleId: 'sale-1' });
    expect(result.data).toMatchObject({
      device_id: 'till-A',
      amount: 123.45,
      hub: expect.anything(),
    });
    expect(state.deviceModel.findOne).toHaveBeenCalledWith({
      device_id: 'till-A',
      revoked: { $ne: true },
    });
  });

  it('rejects a client-supplied device from another session before writing', async () => {
    await expect(
      service.createSale(user, { clientSaleId: 'sale-1', deviceId: 'till-B' }),
    ).rejects.toThrow(ForbiddenException);
    expect(state.saleModel.create).not.toHaveBeenCalled();
  });

  it('rejects revoked devices and location mismatches', async () => {
    state.deviceModel.findOne.mockResolvedValue(null);
    await expect(
      service.createSale(user, { clientSaleId: 'sale-1' }),
    ).rejects.toThrow(ForbiddenException);
    state.deviceModel.findOne.mockResolvedValue({
      hub: '000000000000000000000003',
    });
    await expect(
      service.createSale(user, { clientSaleId: 'sale-1' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('keeps retries idempotent and leaves historical attribution untouched', async () => {
    const existing = { client_sale_id: 'sale-1', hub, amount: 123.45 };
    state.saleModel.findOne.mockReturnValue({ lean: async () => existing });
    expect(await service.createSale(user, { clientSaleId: 'sale-1' })).toEqual({
      data: existing,
      idempotent: true,
    });
    expect(state.saleModel.create).not.toHaveBeenCalled();
    expect(existing).not.toHaveProperty('device_id');
  });

  it('does not return another till or location’s transaction on an idempotency-key collision', async () => {
    state.saleModel.findOne.mockReturnValue({
      lean: async () => ({ hub, device_id: 'till-B' }),
    });
    await expect(
      service.createSale(user, { clientSaleId: 'collision' }),
    ).rejects.toThrow(ForbiddenException);
    state.saleModel.findOne.mockReturnValue({
      lean: async () => ({ hub: '000000000000000000000004' }),
    });
    await expect(
      service.createSale(user, { clientSaleId: 'collision' }),
    ).rejects.toThrow(ForbiddenException);
    expect(state.saleModel.create).not.toHaveBeenCalled();
  });

  it('attributes refunds and voids to the validated originating session device', async () => {
    const original = { hub, amount: 123.45, items: [], save: jest.fn() };
    state.saleModel.findOne.mockImplementation((query) =>
      query.client_sale_id === 'original'
        ? Promise.resolve(original)
        : { lean: async () => null },
    );
    const refund = await service.refundSale(user, 'original', {
      reversalId: 'refund-1',
    });
    expect(refund.data).toMatchObject({
      device_id: 'till-A',
      amount: -123.45,
      reversal_kind: 'refund',
      reversal_of: 'original',
    });
    const voided = await service.voidSale(user, 'original', {
      reversalId: 'void-1',
    });
    expect(voided.data).toMatchObject({
      device_id: 'till-A',
      status: 'Voided',
      reversal_kind: 'void',
    });
    expect(original.save).toHaveBeenCalledTimes(1);
  });
});
