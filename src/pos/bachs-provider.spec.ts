import { createHmac } from 'crypto';
import { BachsProvider } from './bachs-provider';
import { BachsClient } from './bachs.client';

describe('legacy Bachs settlement evidence', () => {
  afterEach(() => jest.restoreAllMocks());
  it('does not treat nested request success or checkout completion as money received', async () => {
    jest
      .spyOn(BachsClient.prototype, 'getCheckout')
      .mockResolvedValue({
        data: {
          checkout_id: 'old',
          status: 'completed',
          amount_received: 100,
          currency: 'NGN',
          instructions: { status: 'success' },
        },
      } as any);
    const evidence = await new BachsProvider('sk_sandbox_test', 'test').check(
      'old',
    );
    expect(evidence.status).toBe('awaiting');
  });
  it('continues recognizing explicit settlement for an already-started payment', async () => {
    jest
      .spyOn(BachsClient.prototype, 'getCheckout')
      .mockResolvedValue({
        data: {
          checkout_id: 'old',
          payment_status: 'paid',
          amount_received: 100,
          currency: 'NGN',
        },
      } as any);
    expect(
      await new BachsProvider('sk_sandbox_test', 'test').check('old'),
    ).toMatchObject({ status: 'paid', amountKobo: 10000, reference: 'old' });
  });
  it('requires explicit settlement in a signed checkout-completed event', () => {
    const provider = new BachsProvider('sk_sandbox_test', 'test');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const deliver = (extra = {}) => {
      const raw = JSON.stringify({
        id: 'event-1',
        type: 'checkout.completed',
        data: {
          checkout_id: 'old',
          status: 'completed',
          amount: 100,
          currency: 'NGN',
          ...extra,
        },
      });
      return provider.webhook(raw, {
        'x-bachs-timestamp': timestamp,
        'x-bachs-signature': createHmac('sha256', 'test')
          .update(`${timestamp}.${raw}`)
          .digest('hex'),
      });
    };
    expect(deliver()).toBeNull();
    expect(deliver({ payment_status: 'paid' })).toMatchObject({
      status: 'paid',
      amountKobo: 10000,
    });
  });
});
