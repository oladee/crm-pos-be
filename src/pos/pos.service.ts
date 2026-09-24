import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import type { PosJwtPayload } from './pos-auth';

const POS_ROLES = new Set(['cashier', 'hub_manager']);
const PIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const PIN_ATTEMPT_LIMIT = 8;

type RoleDoc = { _id: Types.ObjectId; name?: string; label?: string };
type UserDoc = {
  _id: Types.ObjectId;
  full_name: string;
  email: string;
  username?: string;
  is_active?: boolean;
  password?: string;
  pin_hash?: string;
  hub?: Types.ObjectId | { _id: Types.ObjectId };
  role?: RoleDoc | Types.ObjectId;
};
type HubDoc = {
  _id: Types.ObjectId;
  hub_name: string;
  hub_address?: string;
  hub_phone?: string;
  code?: string;
  is_active?: boolean;
  location_type?: string;
  ownership_type?: string | null;
  hub_manager?: Types.ObjectId | null;
};
type ProductDoc = {
  _id: Types.ObjectId;
  sku: string;
  name: string;
  category?: string;
  unit_of_measure?: string;
  current_stock?: number;
  base_selling_price?: number;
  avg_unit_cost?: number;
  is_active?: boolean;
  hub?: Types.ObjectId;
};
type SaleDoc = {
  _id: Types.ObjectId;
  client_sale_id?: string;
  status?: string;
  amount: number;
  hub: Types.ObjectId;
  items?: Array<{
    product?: Types.ObjectId;
    product_name?: string;
    quantity: number;
    unit?: string;
    stock_quantity?: number;
    category?: string;
    batch_number?: string;
    unit_cost?: number;
    unit_price?: number;
  }>;
  item?: {
    product?: Types.ObjectId;
    quantity: number;
    stock_quantity?: number;
    batch_number?: string;
  } | null;
};
type StockLogDoc = {
  _id: Types.ObjectId;
  item?: Types.ObjectId;
  type?: string;
  quantity?: number;
  batch_number?: string;
  unit_cost?: number;
  unit_price?: number;
  expiry_date?: Date;
  date?: Date;
  supplier?: string;
  createdAt?: Date;
};
type DeviceDoc = {
  _id: Types.ObjectId;
  device_id: string;
  hub: Types.ObjectId;
  label?: string;
  last_seen?: Date;
};

type SaleLineIn = {
  productId?: string;
  product?: string;
  name?: string;
  product_name?: string;
  sku?: string;
  unit?: string;
  qty?: number;
  quantity?: number;
  unitPrice?: number;
  unit_price?: number;
  unitCost?: number;
  unit_cost?: number;
  discount?: number;
  lineTotal?: number;
};

function oid(id: string, label = 'id') {
  if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`Invalid ${label}`);
  return new Types.ObjectId(id);
}

function refId(value: Types.ObjectId | { _id: Types.ObjectId } | undefined | null) {
  if (!value) return null;
  if (typeof value === 'object' && '_id' in value) return String(value._id);
  return String(value);
}

function koboToNaira(kobo: number) {
  return Math.round((Number(kobo) || 0)) / 100;
}

function normalizeBatchNumber(value?: string) {
  const s = String(value ?? '').trim().toUpperCase();
  return s || undefined;
}

function storeTypeFromOwnership(ownership?: string | null) {
  return ownership === 'RF' ? 'Franchise' : 'Owned';
}

@Injectable()
export class PosService {
  private pinAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    @InjectModel('User') private readonly userModel: Model<UserDoc>,
    @InjectModel('Role') private readonly roleModel: Model<RoleDoc>,
    @InjectModel('Hub') private readonly hubModel: Model<HubDoc>,
    @InjectModel('Product') private readonly productModel: Model<ProductDoc>,
    @InjectModel('Sale') private readonly saleModel: Model<any>,
    @InjectModel('StockLog') private readonly stockLogModel: Model<any>,
    @InjectModel('PosShift') private readonly shiftModel: Model<any>,
    @InjectModel('PosAssist') private readonly assistModel: Model<any>,
    @InjectModel('PosStockCount') private readonly countModel: Model<any>,
    @InjectModel('PosDevice') private readonly deviceModel: Model<DeviceDoc>,
    private readonly jwt: JwtService,
  ) {}

  private mapPosRole(name?: string): 'cashier' | 'manager' | null {
    if (name === 'cashier') return 'cashier';
    if (name === 'hub_manager') return 'manager';
    return null;
  }

  private toStaff(user: UserDoc, roleName?: string, hubId?: string | null) {
    const role = this.mapPosRole(roleName);
    if (!role) return null;
    return {
      id: String(user._id),
      name: user.full_name,
      username: user.username ?? null,
      email: user.email,
      role,
      hubId: hubId ?? refId(user.hub),
      storeId: hubId ?? refId(user.hub),
      isActive: user.is_active !== false,
    };
  }

  private async getHub(hubId: string) {
    const hub = await this.hubModel.findById(oid(hubId, 'hubId')).lean();
    if (!hub || hub.is_active === false) throw new NotFoundException('Location not found');
    return hub;
  }

  private async assertDeviceHub(deviceId: string | undefined, hubId: string) {
    if (!deviceId) return null;
    const device = await this.deviceModel.findOne({ device_id: deviceId }).lean();
    if (!device) return null;
    if (String(device.hub) !== hubId) {
      throw new ForbiddenException('This till is bound to another location');
    }
    return device;
  }

  private assertJwtHub(user: PosJwtPayload, hubId?: string) {
    const target = hubId || user.hubId;
    if (!target) throw new BadRequestException('hubId is required');
    if (user.hubId && target !== user.hubId) {
      throw new ForbiddenException('Session is scoped to another location');
    }
    return target;
  }

  private mapLocation(h: HubDoc) {
    return {
      id: String(h._id),
      name: h.hub_name,
      address: h.hub_address,
      phone: h.hub_phone,
      code: h.code,
      location_type: h.location_type || 'hub',
      ownership_type: h.ownership_type ?? null,
      storeType: storeTypeFromOwnership(h.ownership_type),
    };
  }

  async listLocations(deviceId?: string) {
    if (deviceId) {
      const bound = await this.deviceModel.findOne({ device_id: deviceId }).lean();
      if (bound) {
        const hub = await this.hubModel.findById(bound.hub).lean();
        return { data: hub && hub.is_active !== false ? [this.mapLocation(hub)] : [] };
      }
    }
    const hubs = await this.hubModel
      .find({ is_active: { $ne: false } })
      .sort({ hub_name: 1 })
      .lean();
    return { data: hubs.map((h) => this.mapLocation(h)) };
  }

  async listStaff(hubId?: string, deviceId?: string) {
    if (!hubId) throw new BadRequestException('hubId is required');
    await this.assertDeviceHub(deviceId, hubId);
    const hub = await this.getHub(hubId);
    const roles = await this.roleModel.find({ name: { $in: [...POS_ROLES] } }).lean();
    const roleById = new Map(roles.map((r) => [String(r._id), r.name]));
    const cashierRole = roles.find((r) => r.name === 'cashier');
    const managerRole = roles.find((r) => r.name === 'hub_manager');

    const or: Record<string, unknown>[] = [];
    if (cashierRole) {
      or.push({ role: cashierRole._id, hub: hub._id, is_active: { $ne: false } });
    }
    if (managerRole) {
      or.push({ role: managerRole._id, hub: hub._id, is_active: { $ne: false } });
    }
    if (hub.hub_manager) {
      or.push({ _id: hub.hub_manager, is_active: { $ne: false } });
    }
    const users = or.length
      ? await this.userModel.find({ $or: or }).select('-password').lean()
      : [];
    const seen = new Set<string>();
    const data = users
      .map((u) => {
        const id = String(u._id);
        if (seen.has(id)) return null;
        seen.add(id);
        return this.toStaff(u, roleById.get(String(u.role)), String(hub._id));
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    return { data };
  }

  private assertManager(actor: PosJwtPayload) {
    if (actor.role !== 'manager') {
      throw new ForbiddenException('Only a hub manager can manage cashiers');
    }
  }

  private generatePosPin() {
    const trivial = new Set([
      '0000', '1111', '2222', '3333', '4444',
      '5555', '6666', '7777', '8888', '9999',
      '1234', '4321', '0123', '3210',
    ]);
    let pin = '';
    do {
      pin = String(Math.floor(1000 + Math.random() * 9000));
    } while (trivial.has(pin));
    return pin;
  }

  private slugName(name: string) {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.+|\.+$/g, '')
        .slice(0, 24) || 'cashier'
    );
  }

  async createCashier(
    actor: PosJwtPayload,
    dto: { full_name?: string; phone?: string; email?: string; pin?: string },
  ) {
    this.assertManager(actor);
    const name = String(dto.full_name || '').trim();
    const phone = String(dto.phone || '').trim();
    if (!name) throw new BadRequestException('full_name is required');
    if (!phone) throw new BadRequestException('phone is required');

    let pin = String(dto.pin || '').trim();
    if (pin) {
      if (!/^\d{4}$/.test(pin)) throw new BadRequestException('PIN must be 4 digits');
    } else {
      pin = this.generatePosPin();
    }

    const cashierRole = await this.roleModel.findOne({ name: 'cashier' });
    if (!cashierRole) throw new BadRequestException('Cashier role is not configured');

    const suffix = Math.random().toString(36).slice(2, 8);
    const email = (dto.email || `cashier.${this.slugName(name)}.${suffix}@pos.local`)
      .toLowerCase()
      .trim();
    const existing = await this.userModel.findOne({ email });
    if (existing) throw new BadRequestException('A user with that email already exists');

    const created = await this.userModel.create({
      full_name: name,
      email,
      username: `${this.slugName(name)}.${suffix}`,
      phone,
      role: cashierRole._id,
      hub: oid(actor.hubId, 'hubId'),
      password: await bcrypt.hash(Math.random().toString(36).slice(-12), 10),
      pin_hash: await bcrypt.hash(pin, 10),
      is_active: true,
    } as any);

    return { staff: this.toStaff(created, 'cashier', actor.hubId), pin };
  }

  async resetCashierPin(actor: PosJwtPayload, staffId: string) {
    this.assertManager(actor);
    if (!Types.ObjectId.isValid(staffId)) throw new BadRequestException('Invalid staff id');
    const user = await this.userModel.findById(staffId).populate('role');
    if (!user) throw new NotFoundException('Staff not found');
    const role = user.role as RoleDoc | undefined;
    if (role?.name !== 'cashier') {
      throw new BadRequestException('Only cashier PINs can be reset on the till');
    }
    if (refId(user.hub) !== actor.hubId) {
      throw new ForbiddenException('Staff is not assigned to this location');
    }
    const pin = this.generatePosPin();
    user.pin_hash = await bcrypt.hash(pin, 10);
    await user.save();
    return { staff: this.toStaff(user, 'cashier', actor.hubId), pin };
  }

  private assertPinRateLimit(key: string) {
    const now = Date.now();
    const current = this.pinAttempts.get(key);
    if (!current || current.resetAt < now) {
      this.pinAttempts.set(key, { count: 1, resetAt: now + PIN_ATTEMPT_WINDOW_MS });
      return;
    }
    current.count += 1;
    if (current.count > PIN_ATTEMPT_LIMIT) {
      throw new UnauthorizedException('Too many PIN attempts. Try again later.');
    }
  }

  private async getHubForUser(user: UserDoc) {
    const userHub = refId(user.hub);
    if (userHub) return this.getHub(userHub);
    const managed = await this.hubModel.findOne({
      hub_manager: user._id,
      is_active: { $ne: false },
    }).lean();
    if (managed) return managed;
    throw new UnauthorizedException('Staff is not assigned to a location');
  }

  async verifyPin(dto: {
    hubId?: string;
    storeId?: string;
    userId?: string;
    username?: string;
    email?: string;
    pin: string;
    deviceId?: string;
    deviceLabel?: string;
  }) {
    const pin = String(dto.pin ?? '').trim();
    if (!/^\d{4}$/.test(pin)) throw new BadRequestException('PIN must be 4 digits');

    const identifier = (dto.userId || dto.username || dto.email || '').toString().toLowerCase();
    if (!identifier) throw new BadRequestException('Username is required');
    this.assertPinRateLimit(identifier);

    let user: UserDoc | null = null;
    if (dto.userId && Types.ObjectId.isValid(dto.userId)) {
      user = await this.userModel.findById(dto.userId).populate('role');
    } else {
      user = await this.userModel
        .findOne({ $or: [{ username: identifier }, { email: identifier }] })
        .populate('role');
    }
    if (!user || user.is_active === false) throw new UnauthorizedException('Invalid PIN');

    const hub = await this.getHubForUser(user);
    await this.assertDeviceHub(dto.deviceId, String(hub._id));

    const role = user.role as RoleDoc | undefined;
    const mapped = this.toStaff(user, role?.name, String(hub._id));
    if (!mapped) throw new UnauthorizedException('Invalid PIN');
    if (!user.pin_hash) throw new UnauthorizedException('Till PIN is not set for this user');
    const ok = await bcrypt.compare(pin, user.pin_hash);
    if (!ok) throw new UnauthorizedException('Invalid PIN');

    if (dto.deviceId) {
      await this.bindDevice({
        deviceId: dto.deviceId,
        hubId: String(hub._id),
        label: dto.deviceLabel,
      });
    }

    const token = this.jwt.sign(
      {
        sub: String(user._id),
        role: mapped.role,
        hubId: String(hub._id),
        ownershipType: hub.ownership_type ?? null,
        deviceId: dto.deviceId,
      } satisfies PosJwtPayload,
      { expiresIn: '12h' },
    );
    return { staff: mapped, token, location: this.mapLocation(hub) };
  }

  async catalog(hubId: string, deviceId?: string) {
    if (!hubId) throw new BadRequestException('hubId is required');
    await this.assertDeviceHub(deviceId, hubId);
    const products = await this.productModel
      .find({ hub: oid(hubId, 'hubId'), is_active: { $ne: false } })
      .sort({ name: 1 })
      .lean();
    return {
      data: products.map((p) => ({
        id: String(p._id),
        sku: p.sku,
        name: p.name,
        category: p.category || 'Other',
        price: Math.round((p.base_selling_price || 0) * 100),
        cost: Math.round((p.avg_unit_cost || 0) * 100),
        unit: p.unit_of_measure || 'Units',
        stock: p.current_stock ?? 0,
        trackStock: true,
        isActive: p.is_active !== false,
      })),
    };
  }

  async bindDevice(dto: { deviceId?: string; hubId?: string; storeId?: string; label?: string }) {
    const deviceId = String(dto.deviceId || '').trim();
    const hubId = dto.hubId || dto.storeId;
    if (!deviceId) throw new BadRequestException('deviceId is required');
    if (!hubId) throw new BadRequestException('hubId is required');
    const hub = await this.getHub(hubId);
    const existing = await this.deviceModel.findOne({ device_id: deviceId });
    if (existing && String(existing.hub) !== String(hub._id)) {
      throw new ForbiddenException('This till is already bound to another location');
    }
    const now = new Date();
    const doc = await this.deviceModel.findOneAndUpdate(
      { device_id: deviceId },
      {
        $set: { hub: hub._id, label: dto.label, last_seen: now },
        $setOnInsert: { bound_at: now },
      },
      { upsert: true, new: true },
    );
    return {
      data: {
        deviceId: doc.device_id,
        hubId: String(doc.hub),
        label: doc.label,
        lastSeen: doc.last_seen,
      },
    };
  }

  async listDevices(user: PosJwtPayload) {
    const rows = await this.deviceModel.find({ hub: oid(user.hubId, 'hubId') }).lean();
    return {
      data: rows.map((d) => ({
        deviceId: d.device_id,
        hubId: String(d.hub),
        label: d.label,
        lastSeen: d.last_seen,
      })),
    };
  }

  private async requireBoundDevice(deviceId: string | undefined, hubId: string) {
    if (!deviceId) throw new BadRequestException('deviceId is required');
    const device = await this.deviceModel.findOne({ device_id: deviceId });
    if (!device) throw new ForbiddenException('Till is not bound to a location');
    if (String(device.hub) !== hubId) {
      throw new ForbiddenException('This till is bound to another location');
    }
    device.last_seen = new Date();
    await device.save();
    return device;
  }

  private async computeRemainingBatches(productId: Types.ObjectId) {
    const logs = await this.stockLogModel
      .find({ item: productId })
      .sort({ date: 1, createdAt: 1 })
      .lean();
    type Batch = {
      batchNumber: string;
      date: Date;
      expiryDate?: Date;
      quantityRemaining: number;
      unitCost: number;
      unitPrice: number;
    };
    const batches: Batch[] = [];
    let anon = 0;
    for (const log of logs) {
      const qty = Math.abs(Number(log.quantity) || 0);
      const inbound =
        log.type === 'PURCHASE' ||
        (log.type === 'TRANSFER' && Number(log.quantity) > 0) ||
        (log.type === 'ADJUSTMENT' && Number(log.quantity) > 0) ||
        log.type === 'RETURN';
      const outbound =
        log.type === 'SALE' ||
        (log.type === 'TRANSFER' && Number(log.quantity) < 0) ||
        (log.type === 'ADJUSTMENT' && Number(log.quantity) < 0);
      if (inbound) {
        const code = normalizeBatchNumber(log.batch_number) || `UNLABELED-${++anon}`;
        const existing = batches.find((b) => b.batchNumber === code);
        if (existing && log.type === 'RETURN') {
          existing.quantityRemaining += qty;
        } else {
          batches.push({
            batchNumber: code,
            date: log.date ? new Date(log.date) : new Date(),
            expiryDate: log.expiry_date ? new Date(log.expiry_date) : undefined,
            quantityRemaining: qty,
            unitCost: Number(log.unit_cost) || 0,
            unitPrice: Number(log.unit_price) || 0,
          });
        }
      } else if (outbound) {
        let toDeduct = qty;
        const target = normalizeBatchNumber(log.batch_number);
        const ordered = [...batches].sort((a, b) => {
          if (a.expiryDate && b.expiryDate) return a.expiryDate.getTime() - b.expiryDate.getTime();
          if (a.expiryDate) return -1;
          if (b.expiryDate) return 1;
          return a.date.getTime() - b.date.getTime();
        });
        const pool = target ? ordered.filter((b) => b.batchNumber === target) : ordered;
        for (const batch of pool) {
          if (toDeduct <= 0) break;
          if (batch.quantityRemaining <= 0) continue;
          const take = Math.min(batch.quantityRemaining, toDeduct);
          batch.quantityRemaining -= take;
          toDeduct -= take;
        }
      }
    }
    return batches.filter((b) => b.quantityRemaining > 0).sort((a, b) => {
      if (a.expiryDate && b.expiryDate) return a.expiryDate.getTime() - b.expiryDate.getTime();
      if (a.expiryDate) return -1;
      if (b.expiryDate) return 1;
      return a.date.getTime() - b.date.getTime();
    });
  }

  private async writeStockLog(input: {
    product: ProductDoc;
    type: 'SALE' | 'RETURN';
    quantity: number;
    unitCost?: number;
    unitPrice?: number;
    referenceId: string;
    agentId: string;
    batchNumber?: string;
    notes: string;
  }) {
    await this.stockLogModel.create({
      item: input.product._id,
      item_name: input.product.name,
      type: input.type,
      quantity: input.quantity,
      uom: input.product.unit_of_measure || 'Units',
      unit_cost: input.unitCost || 0,
      unit_price: input.unitPrice || 0,
      reference_id: input.referenceId,
      notes: input.notes,
      agent: oid(input.agentId, 'agent'),
      batch_number: input.batchNumber,
      date: new Date(),
    });
  }

  private async deductProductStock(
    product: ProductDoc,
    qty: number,
    unitPrice: number,
    saleId: string,
    agentId: string,
  ) {
    const batches = await this.computeRemainingBatches(product._id);
    let remaining = qty;
    if (batches.length > 0) {
      for (const batch of batches) {
        if (remaining <= 0) break;
        const take = Math.min(batch.quantityRemaining, remaining);
        await this.writeStockLog({
          product,
          type: 'SALE',
          quantity: -take,
          unitCost: batch.unitCost,
          unitPrice,
          referenceId: saleId,
          agentId,
          batchNumber: batch.batchNumber,
          notes: 'POS sale',
        });
        remaining -= take;
      }
    }
    if (remaining > 0) {
      await this.writeStockLog({
        product,
        type: 'SALE',
        quantity: -remaining,
        unitCost: product.avg_unit_cost || 0,
        unitPrice,
        referenceId: saleId,
        agentId,
        notes: 'POS sale',
      });
    }
    const next = Math.max(0, (Number(product.current_stock) || 0) - qty);
    await this.productModel.updateOne(
      { _id: product._id },
      { $set: { current_stock: next, last_stock_update: new Date() } },
    );
  }

  private async restoreProductStock(
    product: ProductDoc,
    qty: number,
    unitPrice: number,
    saleId: string,
    agentId: string,
    batchNumber?: string,
  ) {
    await this.writeStockLog({
      product,
      type: 'RETURN',
      quantity: Math.abs(qty),
      unitCost: product.avg_unit_cost || 0,
      unitPrice,
      referenceId: saleId,
      agentId,
      batchNumber,
      notes: 'POS reversal',
    });
    const next = (Number(product.current_stock) || 0) + Math.abs(qty);
    await this.productModel.updateOne(
      { _id: product._id },
      { $set: { current_stock: next, last_stock_update: new Date() } },
    );
  }

  private paymentType(method?: string) {
    const m = String(method || 'Cash');
    if (m === 'Transfer') return 'Transfer';
    if (m === 'Card' || m === 'POS') return 'POS';
    return 'Cash';
  }

  private paymentMode(method?: string) {
    return method === 'Credit' ? 'Full Credit' : 'Full Payment';
  }

  private lineQty(line: SaleLineIn) {
    return Math.abs(Number(line.qty ?? line.quantity ?? 0));
  }

  private lineUnitPriceNaira(line: SaleLineIn) {
    if (line.unit_price != null) return Number(line.unit_price);
    return koboToNaira(Number(line.unitPrice || 0));
  }

  private lineUnitCostNaira(line: SaleLineIn) {
    if (line.unit_cost != null) return Number(line.unit_cost);
    return koboToNaira(Number(line.unitCost || 0));
  }

  async createSale(user: PosJwtPayload, payload: Record<string, any>) {
    const clientSaleId = String(payload.clientSaleId || payload.id || '').trim();
    if (!clientSaleId) throw new BadRequestException('clientSaleId is required');
    const hubId = this.assertJwtHub(user, payload.hubId || payload.storeId || user.hubId);
    await this.requireBoundDevice(payload.deviceId || user.deviceId, hubId);

    const existing = await this.saleModel.findOne({ client_sale_id: clientSaleId }).lean();
    if (existing) return { data: existing, idempotent: true };

    const lines: SaleLineIn[] = payload.items || payload.lines || [];
    if (!lines.length) throw new BadRequestException('Sale has no items');

    const mappedItems: Array<{
      product?: Types.ObjectId;
      product_name: string;
      quantity: number;
      unit?: string;
      stock_quantity: number;
      category?: string;
      unit_cost: number;
      unit_price: number;
    }> = [];
    let profit = 0;
    for (const line of lines) {
      const productId = line.productId || line.product;
      const qty = this.lineQty(line);
      const unitPrice = this.lineUnitPriceNaira(line);
      const unitCost = this.lineUnitCostNaira(line);
      const product =
        productId && Types.ObjectId.isValid(productId)
          ? await this.productModel.findById(productId)
          : null;
      if (product && String(product.hub) !== hubId) {
        throw new ForbiddenException(`${product.name} is not stocked at this location`);
      }
      profit += (unitPrice - unitCost) * qty;
      mappedItems.push({
        product: product?._id,
        product_name: line.name || line.product_name || product?.name || 'Item',
        quantity: qty,
        unit: line.unit || product?.unit_of_measure,
        stock_quantity: qty,
        category: product?.category,
        unit_cost: unitCost,
        unit_price: unitPrice,
      });
    }

    const total = payload.total != null ? koboToNaira(payload.total) : Number(payload.amount) || 0;
    const firstPay = (payload.payments || [])[0];
    const agentName = payload.cashierName || payload.agent_name || 'Cashier';
    const amount = Math.round(total * 100) / 100;
    const profitAmount = Math.round(profit * 100) / 100;

    const created = await this.saleModel.create({
      customer: null,
      customer_name: payload.customerName || 'Walk-in',
      amount,
      profit_margin: amount ? Math.round((profitAmount / amount) * 10000) / 100 : 0,
      profit_amount: profitAmount,
      date: payload.createdAt ? new Date(payload.createdAt) : new Date(),
      agent: oid(user.sub, 'cashier'),
      agent_name: agentName,
      hub: oid(hubId, 'hubId'),
      status: 'Paid',
      item: mappedItems[0] || null,
      items: mappedItems,
      notes: payload.note || payload.notes,
      channel: 'POS',
      delivery_status: 'N/A',
      payment_type: this.paymentType(firstPay?.method),
      payment_mode: this.paymentMode(firstPay?.method),
      amount_paid: this.paymentMode(firstPay?.method) === 'Full Credit' ? 0 : amount,
      source: 'pos',
      client_sale_id: clientSaleId,
    });

    for (const line of mappedItems) {
      if (!line.product) continue;
      const product = await this.productModel.findById(line.product);
      if (!product) continue;
      await this.deductProductStock(
        product,
        line.quantity,
        line.unit_price,
        clientSaleId,
        user.sub,
      );
    }

    return { data: created };
  }

  private async createReversal(
    user: PosJwtPayload,
    originalClientId: string,
    payload: Record<string, any>,
    kind: 'refund' | 'void',
  ) {
    const hubId = this.assertJwtHub(user, payload.hubId || user.hubId);
    await this.requireBoundDevice(payload.deviceId || user.deviceId, hubId);
    const reversalId = String(payload.reversalId || payload.id || '').trim();
    if (!reversalId) throw new BadRequestException('reversalId is required');

    const existing = await this.saleModel.findOne({ client_sale_id: reversalId }).lean();
    if (existing) return { data: existing, idempotent: true };

    const original = await this.saleModel.findOne({ client_sale_id: originalClientId });
    if (!original) throw new NotFoundException('Original sale not found');
    if (String(original.hub) !== hubId) {
      throw new ForbiddenException('Sale belongs to another location');
    }

    const sourceLines = payload.lines || payload.items || original.items || (original.item ? [original.item] : []);
    const mappedItems = (sourceLines as SaleLineIn[]).map((line) => {
      const qty = this.lineQty(line) || Number((line as any).quantity) || 0;
      const unitPrice = this.lineUnitPriceNaira(line);
      return {
        product: line.productId && Types.ObjectId.isValid(line.productId)
          ? oid(line.productId)
          : (line as any).product,
        product_name: line.name || line.product_name,
        quantity: -Math.abs(qty),
        unit: line.unit,
        stock_quantity: -Math.abs(qty),
        unit_cost: this.lineUnitCostNaira(line),
        unit_price: unitPrice,
        batch_number: (line as any).batch_number,
      };
    });

    const amount = payload.total != null
      ? koboToNaira(payload.total)
      : -Math.abs(original.amount);
    const firstPay = (payload.payments || [])[0];

    if (kind === 'void') {
      original.status = 'Voided';
      await original.save();
    }

    const created = await this.saleModel.create({
      customer: null,
      customer_name: payload.customerName || 'Walk-in',
      amount,
      profit_amount: 0,
      profit_margin: 0,
      date: payload.createdAt ? new Date(payload.createdAt) : new Date(),
      agent: oid(user.sub, 'cashier'),
      agent_name: payload.cashierName || payload.refundedBy || 'Cashier',
      hub: oid(hubId, 'hubId'),
      status: kind === 'void' ? 'Voided' : 'Paid',
      item: mappedItems[0] || null,
      items: mappedItems,
      notes: payload.refundReason || payload.reason || payload.note,
      channel: 'POS',
      payment_type: this.paymentType(firstPay?.method),
      payment_mode: 'Full Payment',
      amount_paid: amount,
      source: 'pos',
      client_sale_id: reversalId,
      reversal_of: originalClientId,
      reversal_kind: kind,
    });

    for (const line of mappedItems) {
      if (!line.product) continue;
      const product = await this.productModel.findById(line.product);
      if (!product) continue;
      await this.restoreProductStock(
        product,
        Math.abs(line.quantity),
        line.unit_price || 0,
        reversalId,
        user.sub,
        line.batch_number,
      );
    }

    return { data: created };
  }

  refundSale(user: PosJwtPayload, clientSaleId: string, payload: Record<string, any>) {
    return this.createReversal(user, clientSaleId, payload, 'refund');
  }

  voidSale(user: PosJwtPayload, clientSaleId: string, payload: Record<string, any>) {
    return this.createReversal(user, clientSaleId, payload, 'void');
  }

  async upsertShift(user: PosJwtPayload, payload: Record<string, any>) {
    const hubId = this.assertJwtHub(user, payload.hubId || user.hubId);
    await this.requireBoundDevice(payload.deviceId || user.deviceId, hubId);
    const clientId = String(payload.id || payload.clientShiftId || '').trim();
    if (!clientId) throw new BadRequestException('shift id is required');
    const doc = await this.shiftModel.findOneAndUpdate(
      { client_shift_id: clientId },
      {
        $set: {
          hub: oid(hubId, 'hubId'),
          device_id: payload.deviceId,
          cashier: Types.ObjectId.isValid(payload.cashierId) ? oid(payload.cashierId) : undefined,
          cashier_name: payload.cashierName,
          opened_at: payload.openedAt ? new Date(payload.openedAt) : new Date(),
          closed_at: payload.closedAt ? new Date(payload.closedAt) : undefined,
          opening_float: payload.openingFloat,
          counted_cash: payload.countedCash,
          expected_cash: payload.expectedCash,
          variance: payload.variance,
          status: payload.status || 'open',
          note: payload.note,
        },
      },
      { upsert: true, new: true },
    );
    return { data: doc };
  }

  async listShifts(user: PosJwtPayload) {
    const rows = await this.shiftModel
      .find({ hub: oid(user.hubId, 'hubId') })
      .sort({ opened_at: -1 })
      .lean();
    return { data: rows };
  }

  async upsertAssist(user: PosJwtPayload, payload: Record<string, any>) {
    const hubId = this.assertJwtHub(user, payload.hubId || user.hubId);
    await this.requireBoundDevice(payload.deviceId || user.deviceId, hubId);
    const clientId = String(payload.id || payload.clientAssistId || '').trim();
    if (!clientId) throw new BadRequestException('assist id is required');
    const doc = await this.assistModel.findOneAndUpdate(
      { client_assist_id: clientId },
      {
        $set: {
          hub: oid(hubId, 'hubId'),
          device_id: payload.deviceId,
          shift_id: payload.shiftId,
          cashier: Types.ObjectId.isValid(payload.cashierId) ? oid(payload.cashierId) : undefined,
          cashier_name: payload.cashierName,
          type: payload.type,
          urgent: !!payload.urgent,
          note: payload.note,
          context: payload.context,
          status: payload.status || 'open',
          claimed_by: payload.claimedBy,
          claimed_at: payload.claimedAt ? new Date(payload.claimedAt) : undefined,
          resolved_by: payload.resolvedBy,
          resolved_at: payload.resolvedAt ? new Date(payload.resolvedAt) : undefined,
          resolution: payload.resolution,
          action: payload.action,
        },
      },
      { upsert: true, new: true },
    );
    return { data: doc };
  }

  async listAssists(user: PosJwtPayload) {
    const rows = await this.assistModel
      .find({ hub: oid(user.hubId, 'hubId') })
      .sort({ createdAt: -1 })
      .lean();
    return { data: rows };
  }

  async patchAssist(user: PosJwtPayload, clientAssistId: string, payload: Record<string, any>) {
    return this.upsertAssist(user, { ...payload, id: clientAssistId });
  }

  async upsertStockCount(user: PosJwtPayload, payload: Record<string, any>) {
    const hubId = this.assertJwtHub(user, payload.hubId || user.hubId);
    await this.requireBoundDevice(payload.deviceId || user.deviceId, hubId);
    const day = String(payload.day || payload.id || '').trim();
    if (!day) throw new BadRequestException('day is required');
    const counts: Record<string, number> = payload.counts || {};
    const products = await this.productModel
      .find({ hub: oid(hubId, 'hubId'), is_active: { $ne: false } })
      .lean();
    const expected: Record<string, number> = {};
    const variances: Record<string, number> = {};
    for (const p of products) {
      const id = String(p._id);
      expected[id] = Number(p.current_stock) || 0;
      if (counts[id] != null) variances[id] = Number(counts[id]) - expected[id];
    }
    const doc = await this.countModel.findOneAndUpdate(
      { hub: oid(hubId, 'hubId'), day, device_id: payload.deviceId || user.deviceId },
      {
        $set: {
          counts,
          counted_by: payload.countedBy,
          counted_at: payload.countedAt ? new Date(payload.countedAt) : new Date(),
          variances,
        },
      },
      { upsert: true, new: true },
    );
    return { data: { ...doc.toObject?.() ?? doc, expected, variances } };
  }

  async listStockCounts(user: PosJwtPayload) {
    const rows = await this.countModel
      .find({ hub: oid(user.hubId, 'hubId') })
      .sort({ day: -1 })
      .lean();
    return { data: rows };
  }
}
