import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BachsClient, isPaidStatus, nairaToKobo, readTransferInstructions } from './bachs.client';
import { verifyBachsSignature } from './bachs-signature';
import { PosJwtPayload } from './pos-auth';
import { PosService } from './pos.service';

type TransferDoc = {
  client_sale_id: string;
  checkout_id?: string;
  hub: Types.ObjectId;
  device_id?: string;
  cashier?: Types.ObjectId;
  cashier_name?: string;
  status: 'awaiting' | 'paid' | 'cancelled' | 'expired';
  cart_total_kobo: number;
  payable_kobo: number;
  currency: string;
  bank_name?: string;
  account_name?: string;
  account_number?: string;
  expires_at?: Date;
  sale_payload: Record<string, unknown>;
  event_ids: string[];
  paid_at?: Date;
};

@Injectable()
export class PosTransferService {
  constructor(
    @InjectModel('PosTransfer') private readonly transfers: Model<TransferDoc>,
    private readonly pos: PosService,
  ) {}

  private client() {
    const apiKey = process.env.BACHS_API_KEY || '';
    if (!apiKey) throw new ServiceUnavailableException('Bank transfer is not configured');
    return new BachsClient(apiKey);
  }

  private view(row: TransferDoc) {
    return {
      clientSaleId: row.client_sale_id,
      checkoutId: row.checkout_id || '',
      status: row.status,
      bankName: row.bank_name || '',
      accountName: row.account_name || '',
      accountNumber: row.account_number || '',
      payableKobo: row.payable_kobo,
      cartTotalKobo: row.cart_total_kobo,
      currency: row.currency || 'NGN',
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      sale: row.sale_payload,
    };
  }

  async start(user: PosJwtPayload, payload: Record<string, any>) {
    const clientSaleId = String(payload.clientSaleId || '').trim();
    if (!clientSaleId) throw new BadRequestException('clientSaleId is required');
    const hubId = String(payload.hubId || payload.storeId || user.hubId || '');
    if (hubId !== user.hubId) throw new ForbiddenException('This till is bound to another location');
    const deviceId = String(payload.deviceId || user.deviceId || '');
    const existing = await this.transfers.findOne({ client_sale_id: clientSaleId });
    if (existing) {
      if (String(existing.hub) !== hubId) throw new ForbiddenException('This transfer belongs to another location');
      return this.view(existing);
    }

    const quote = await this.pos.quoteSale(user, payload);
    const salePayload = {
      ...payload,
      clientSaleId,
      hubId,
      deviceId,
      total: quote.total,
    };
    const opened = await this.client().openBankTransfer({
      clientSaleId,
      amountKobo: quote.total,
      hubId,
      deviceId,
    });
    const created = await this.transfers.create({
      client_sale_id: clientSaleId,
      checkout_id: opened.checkoutId,
      hub: new Types.ObjectId(hubId),
      device_id: deviceId,
      cashier: Types.ObjectId.isValid(user.sub) ? new Types.ObjectId(user.sub) : undefined,
      cashier_name: payload.cashierName,
      status: 'awaiting',
      cart_total_kobo: quote.total,
      payable_kobo: opened.payableKobo,
      currency: opened.currency,
      bank_name: opened.bankName,
      account_name: opened.accountName,
      account_number: opened.accountNumber,
      expires_at: opened.expiresAt ? new Date(opened.expiresAt) : undefined,
      sale_payload: salePayload,
      event_ids: [],
    });
    return this.view(created);
  }

  async list(user: PosJwtPayload, deviceId?: string) {
    const filter: Record<string, unknown> = { hub: user.hubId, status: 'awaiting' };
    if (deviceId) filter.device_id = deviceId;
    const rows = await this.transfers.find(filter).sort({ createdAt: -1 }).limit(30);
    return { data: rows.map((row) => this.view(row)) };
  }

  async status(user: PosJwtPayload, clientSaleId: string, refresh: boolean) {
    const row = await this.transfers.findOne({ client_sale_id: clientSaleId });
    if (!row) throw new NotFoundException('Transfer not found');
    if (String(row.hub) !== user.hubId) throw new ForbiddenException('This transfer belongs to another location');
    if (row.status !== 'awaiting' || !refresh || !row.checkout_id) return this.view(row);

    const remote = await this.client().getCheckout(row.checkout_id);
    const read = readTransferInstructions(remote, row.payable_kobo);
    if (isPaidStatus(read.status)) {
      const paid = await this.markPaid(row, read.payableKobo || row.payable_kobo, `poll:${row.checkout_id}`);
      return this.view(paid);
    }
    const remoteStatus = read.status.toLowerCase();
    if (remoteStatus === 'expired') {
      row.status = 'expired';
      await row.save();
    }
    return this.view(row);
  }

  async cancel(user: PosJwtPayload, clientSaleId: string) {
    const row = await this.transfers.findOne({ client_sale_id: clientSaleId });
    if (!row) throw new NotFoundException('Transfer not found');
    if (String(row.hub) !== user.hubId) throw new ForbiddenException('This transfer belongs to another location');
    if (row.status === 'paid') throw new BadRequestException('This transfer is already paid');
    if (row.status === 'awaiting') {
      row.status = 'cancelled';
      await row.save();
    }
    return this.view(row);
  }

  async handleWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>) {
    const secret = process.env.BACHS_WEBHOOK_SECRET || '';
    if (!secret) throw new ServiceUnavailableException('Webhook secret is not set');
    if (!verifyBachsSignature(rawBody, headers, secret)) {
      throw new BadRequestException('Invalid webhook signature');
    }
    const event = JSON.parse(rawBody) as { id?: string; type?: string; data?: Record<string, unknown> };
    const eventId = String(event.id || '');
    if (!eventId) return { received: true };
    const data = event.data || {};
    if (event.type === 'checkout.expired') {
      await this.expire(data);
      return { received: true };
    }
    if (event.type !== 'collection.succeeded' && event.type !== 'checkout.completed') return { received: true };

    const checkoutId = String(data.checkout_id || '');
    const reference = String(data.reference || '');
    const row = await this.transfers.findOne(checkoutId
      ? { checkout_id: checkoutId }
      : { client_sale_id: reference });
    if (!row || row.status === 'paid' || row.status === 'cancelled') return { received: true };
    if (row.event_ids?.includes(eventId)) return { received: true };
    const paidKobo = nairaToKobo((data.amount as string | number) || 0);
    if (event.type === 'checkout.completed' && !isPaidStatus(String(data.status || 'succeeded'))) {
      return { received: true };
    }
    await this.markPaid(row, paidKobo, eventId);
    return { received: true };
  }

  private async expire(data: Record<string, unknown>) {
    const checkoutId = String(data.checkout_id || '');
    if (!checkoutId) return;
    await this.transfers.updateOne(
      { checkout_id: checkoutId, status: 'awaiting' },
      { $set: { status: 'expired' } },
    );
  }

  private async markPaid(row: TransferDoc & { save: () => Promise<unknown> }, paidKobo: number, eventId: string) {
    if (row.status === 'paid') return row;
    if (paidKobo + 1 < row.payable_kobo) {
      throw new BadRequestException('The amount received does not cover this transfer');
    }
    const payload = row.sale_payload || {};
    const user: PosJwtPayload = {
      sub: String(row.cashier || ''),
      role: 'cashier',
      hubId: String(row.hub),
      deviceId: row.device_id,
    };
    await this.pos.createSale(user, {
      ...payload,
      clientSaleId: row.client_sale_id,
      hubId: String(row.hub),
      deviceId: row.device_id,
      total: row.cart_total_kobo,
      payments: [{ method: 'Transfer', amount: row.cart_total_kobo, reference: row.checkout_id }],
    });
    row.status = 'paid';
    row.paid_at = new Date();
    row.event_ids = [...(row.event_ids || []), eventId].filter(Boolean);
    await row.save();
    return row;
  }
}
