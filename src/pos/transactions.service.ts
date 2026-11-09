import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { CheckoutService } from './checkout.service';
import { PosJwtPayload } from './pos-auth';

const cents = (value: any) => Math.round(Number(value || 0) * 100);
const escape = (text: string) =>
  Array.from(text, (character) =>
    '\\^$.*+?()[]{}|'.includes(character) ? '\\' + character : character,
  ).join('');

@Injectable()
export class TransactionsService {
  constructor(
    @InjectConnection() private readonly db: Connection,
    private readonly checkouts: CheckoutService,
  ) {}
  private model(name: string): Model<any> {
    return this.db.model(name) as unknown as Model<any>;
  }

  private pipeline(user: PosJwtPayload): any[] {
    const hub = new Types.ObjectId(user.hubId);
    const project = (
      source: string,
      status: any,
      date: any,
      customer: any,
    ) => ({
      $project: {
        source: { $literal: source },
        reference: { $ifNull: ['$client_sale_id', { $toString: '$_id' }] },
        key: { $concat: [source + ':', { $toString: '$_id' }] },
        status,
        date,
        customer,
      },
    });
    const absent = (from: string) => [
      {
        $lookup: {
          from,
          localField: 'client_sale_id',
          foreignField: 'client_sale_id',
          as: 'represented',
        },
      },
      { $match: { 'represented.0': { $exists: false } } },
    ];
    const financial = (source: string, normalStatus: any) => [
      ...(source === 'sale'
        ? []
        : [
            {
              $lookup: {
                from: 'sales',
                localField: 'client_sale_id',
                foreignField: 'client_sale_id',
                as: 'originalSale',
              },
            },
          ]),
      {
        $lookup: {
          from: 'sales',
          let: {
            reference: { $ifNull: ['$client_sale_id', { $toString: '$_id' }] },
          },
          pipeline: [
            {
              $match: { hub, $expr: { $eq: ['$reversal_of', '$$reference'] } },
            },
          ],
          as: 'returns',
        },
      },
      {
        $set: {
          displayStatus: {
            $switch: {
              branches: [
                {
                  case: {
                    $eq: [
                      source === 'sale'
                        ? '$status'
                        : { $arrayElemAt: ['$originalSale.status', 0] },
                      'Voided',
                    ],
                  },
                  then: 'voided',
                },
                {
                  case: {
                    $and: [
                      { $gt: [{ $size: '$returns' }, 0] },
                      {
                        $gte: [
                          { $abs: { $sum: '$returns.amount' } },
                          source === 'sale'
                            ? '$amount'
                            : {
                                $divide: [
                                  source === 'checkout'
                                    ? '$total_kobo'
                                    : '$cart_total_kobo',
                                  100,
                                ],
                              },
                        ],
                      },
                    ],
                  },
                  then: 'refunded',
                },
              ],
              default: normalStatus,
            },
          },
        },
      },
    ];
    return [
      { $match: { hub } },
      ...financial('checkout', '$status'),
      project('checkout', '$displayStatus', '$createdAt', '$customer_name'),
      {
        $unionWith: {
          coll: 'pos_transfers',
          pipeline: [
            { $match: { hub } },
            ...absent('pos_checkouts'),
            ...financial('transfer', {
              $switch: {
                branches: [
                  { case: { $eq: ['$status', 'paid'] }, then: 'completed' },
                  {
                    case: { $in: ['$status', ['review', 'expired']] },
                    then: 'review',
                  },
                  {
                    case: { $eq: ['$status', 'cancelled'] },
                    then: 'cancelled',
                  },
                ],
                default: 'awaiting',
              },
            }),
            project(
              'transfer',
              '$displayStatus',
              '$createdAt',
              '$sale_payload.customerName',
            ),
          ],
        },
      },
      {
        $unionWith: {
          coll: 'sales',
          pipeline: [
            {
              $match: {
                hub,
                reversal_of: { $in: [null, ''] },
                $or: [{ channel: 'POS' }, { source: 'pos' }],
              },
            },
            ...absent('pos_checkouts'),
            ...absent('pos_transfers'),
            ...financial('sale', 'completed'),
            project('sale', '$displayStatus', '$date', '$customer_name'),
          ],
        },
      },
    ];
  }

  async list(user: PosJwtPayload, query: Record<string, string>) {
    await this.checkouts.actor(user);
    const pipeline = this.pipeline(user);
    const filter: any = {};
    if (query.q) {
      if (typeof query.q !== 'string' || query.q.length > 100)
        throw new BadRequestException('Search is too long or invalid');
      const regex = new RegExp(escape(query.q), 'i');
      filter.$or = [{ reference: regex }, { customer: regex }];
    }
    if (query.status) {
      if (
        ![
          'completed',
          'awaiting',
          'review',
          'cancelled',
          'voided',
          'refunded',
        ].includes(query.status)
      )
        throw new BadRequestException('Invalid status');
      filter.status = query.status;
    }
    if (query.date) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(query.date) ||
        !Number.isFinite(+new Date(query.date))
      )
        throw new BadRequestException('Invalid date');
      const start = new Date(query.date + 'T00:00:00+01:00');
      filter.date = { $gte: start, $lt: new Date(+start + 86400000) };
    }
    pipeline.push({ $match: filter });
    if (query.before) {
      try {
        if (typeof query.before !== 'string' || query.before.length > 1000)
          throw new Error();
        const cursor = JSON.parse(
          Buffer.from(query.before, 'base64url').toString(),
        );
        if (
          typeof cursor.key !== 'string' ||
          !Number.isFinite(+new Date(cursor.date))
        )
          throw new Error();
        pipeline.push({
          $match: {
            $or: [
              { date: { $lt: new Date(cursor.date) } },
              { date: new Date(cursor.date), key: { $lt: cursor.key } },
            ],
          },
        });
      } catch {
        throw new BadRequestException('Invalid page cursor');
      }
    }
    pipeline.push({ $sort: { date: -1, key: -1 } }, { $limit: 51 });
    const rows = await this.model('PosCheckout').aggregate(pipeline);
    const page = rows.slice(0, 50),
      last = page.at(-1);
    return {
      data: await Promise.all(page.map((row) => this.display(user, row))),
      nextCursor:
        rows.length > 50
          ? Buffer.from(
              JSON.stringify({ date: last.date, key: last.key }),
            ).toString('base64url')
          : null,
    };
  }

  async get(user: PosJwtPayload, reference: string) {
    await this.checkouts.actor(user);
    const rows = await this.model('PosCheckout').aggregate([
      ...this.pipeline(user),
      { $match: { reference } },
      { $limit: 1 },
    ]);
    if (!rows[0])
      throw new NotFoundException('Transaction not found at this location');
    return this.display(user, rows[0]);
  }

  private async display(user: PosJwtPayload, entry: any) {
    const names = {
      checkout: 'PosCheckout',
      transfer: 'PosTransfer',
      sale: 'Sale',
    };
    const row = await this.model(names[entry.source])
      .findById(entry._id)
      .lean();
    const hub = await this.model('Hub').findById(user.hubId).lean();
    const device = row.device_id
      ? await this.model('PosDevice')
          .findOne({ device_id: row.device_id, hub: user.hubId })
          .lean()
      : null;
    const store = {
      storeName: hub?.hub_name,
      deviceLabel: device?.label,
      receiptFooter: undefined,
    };
    if (
      entry.source === 'transfer' &&
      ['completed', 'voided', 'refunded'].includes(entry.status) &&
      !row.priced_snapshot
    ) {
      const storedSale = await this.model('Sale')
        .findOne({ hub: user.hubId, client_sale_id: row.client_sale_id })
        .select('_id')
        .lean();
      if (storedSale) {
        const legacy = await this.display(user, {
          ...entry,
          source: 'sale',
          _id: storedSale._id,
        });
        if (legacy.receipt)
          legacy.receipt.receiptPayment = {
            provider: row.provider || 'bachs',
            checkoutReference: row.checkout_id,
            feeKobo: row.fee_kobo,
            paidKobo: row.confirmed_amount_kobo ?? row.payable_kobo,
            confirmedAt: row.confirmed_at,
            confirmationSource: row.confirmation_source,
          };
        return legacy;
      }
    }
    const owner = String(row.cashier || row.agent) === user.sub;
    const canManage = owner || user.role === 'manager';
    let receipt: any = null;
    if (entry.source === 'checkout') receipt = row.receipt || null;
    else if (['completed', 'voided', 'refunded'].includes(entry.status)) {
      if (entry.source === 'transfer' && row.priced_snapshot) {
        const snap = row.priced_snapshot;
        receipt = {
          id: entry.reference,
          deviceId: row.device_id,
          storeId: user.hubId,
          hubId: user.hubId,
          cashierId: String(row.cashier),
          cashierName: row.cashier_name,
          customerName: row.sale_payload?.customerName,
          createdAt: row.createdAt,
          status: 'completed',
          syncState: 'synced',
          total: row.cart_total_kobo,
          subtotal: snap.subtotal,
          discount: snap.discount || 0,
          tax: snap.tax,
          taxRatePct: snap.taxRatePct,
          payments: [{ method: 'Transfer', amount: row.cart_total_kobo }],
          change: 0,
          lines: snap.lines.map((line: any) => ({
            productId: String(line.product?._id || ''),
            name: line.name,
            qty: line.quantity,
            unit: line.saleUnit,
            saleUnit: line.saleUnit,
            unitPrice: line.unitPriceKobo,
            discount: line.discountKobo,
            lineTotal:
              Math.round(line.quantity * line.unitPriceKobo) -
              line.discountKobo,
            saleWeightKg: line.saleWeightKg,
          })),
          receiptPayment: {
            provider: row.provider || 'bachs',
            checkoutReference: row.checkout_id,
            feeKobo: row.fee_kobo,
            paidKobo: row.confirmed_amount_kobo ?? row.payable_kobo,
            confirmedAt: row.confirmed_at,
            confirmationSource: row.confirmation_source,
          },
        };
      } else if (entry.source === 'sale') {
        const lines = (
          row.items?.length ? row.items : row.item ? [row.item] : []
        ).map((line: any) => ({
          productId: String(line.product || ''),
          name: line.product_name,
          qty: line.quantity,
          unit: line.unit,
          saleUnit: line.sale_unit || line.unit,
          unitPrice: cents(line.unit_price),
          discount: 0,
          lineTotal: Math.round(Number(line.quantity) * cents(line.unit_price)),
          saleWeightKg:
            line.sale_weight_kg != null
              ? Number(line.sale_weight_kg)
              : undefined,
        }));
        const total = cents(row.amount),
          paid = cents(row.amount_paid);
        receipt = {
          id: entry.reference,
          deviceId: row.device_id,
          storeId: user.hubId,
          hubId: user.hubId,
          cashierId: String(row.agent),
          cashierName: row.agent_name,
          customerName: row.customer_name,
          customerId: row.customer ? String(row.customer) : undefined,
          createdAt: row.date,
          kind: 'sale',
          status: entry.status === 'voided' ? 'voided' : 'completed',
          syncState: 'synced',
          total,
          subtotal: lines.reduce((sum, line) => sum + line.lineTotal, 0),
          discount: 0,
          creditId: row.credit_record ? String(row.credit_record) : undefined,
          dueDate: row.due_date,
          lines,
          payments: [],
          change: 0,
        };
        if (row.payment_type && paid > 0)
          receipt.payments.push({
            method: row.payment_type === 'POS' ? 'Card' : row.payment_type,
            amount: paid,
          });
        if (row.payment_mode !== 'Full Payment' && total > paid)
          receipt.payments.push({ method: 'Credit', amount: total - paid });
      }
    }
    if (receipt) {
      const returns = await this.model('Sale')
        .find({ hub: user.hubId, reversal_of: entry.reference })
        .select('items item')
        .lean();
      const returnedQty: Record<string, number> = {};
      for (const reversal of returns)
        for (const line of reversal.items?.length
          ? reversal.items
          : reversal.item
            ? [reversal.item]
            : []) {
          const id = String(line.product);
          returnedQty[id] =
            (returnedQty[id] || 0) + Math.abs(line.quantity || 0);
        }
      receipt = {
        ...receipt,
        status: ['refunded', 'voided'].includes(entry.status)
          ? entry.status
          : receipt.status,
        returnedQty: Object.keys(returnedQty).length
          ? returnedQty
          : receipt.returnedQty,
        origin: {
          ...Object.fromEntries(
            Object.entries(store).filter(([, value]) => value != null),
          ),
          ...(receipt.origin || {}),
        },
      };
    }
    return {
      reference: entry.reference,
      kind: row.kind || 'sale',
      status: entry.status,
      createdAt: entry.date,
      customerName: row.customer_name || row.sale_payload?.customerName || null,
      cashierName: row.cashier_name || row.agent_name,
      cashierId: String(row.cashier || row.agent),
      deviceId: row.device_id,
      locationId: user.hubId,
      locationName: hub?.hub_name,
      tillName: device?.label,
      totalKobo: row.total_kobo ?? row.cart_total_kobo ?? cents(row.amount),
      receipt,
      checkoutId:
        entry.source === 'checkout' &&
        canManage &&
        ['awaiting', 'review'].includes(entry.status)
          ? String(row._id)
          : null,
      legacyTransferId:
        entry.source === 'transfer' &&
        canManage &&
        ['awaiting', 'review'].includes(entry.status)
          ? row.client_sale_id
          : null,
      actions: {
        viewReceipt: Boolean(receipt),
        printReceipt: Boolean(receipt),
        refund:
          Boolean(row.client_sale_id && receipt) &&
          row.kind !== 'repayment' &&
          entry.status === 'completed' &&
          canManage,
        void:
          Boolean(row.client_sale_id && receipt) &&
          row.kind !== 'repayment' &&
          entry.status === 'completed' &&
          user.role === 'manager',
      },
    };
  }
}
