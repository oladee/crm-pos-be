import { allocateFifo } from './fifo';
import { fenceProduct } from './inventory-guard';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { PosJwtPayload } from './pos-auth';
import { PosPasskeyService } from './pos-passkey.service';

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
  reserved_stock?: number;
  reserved_batches?: Record<string, number>;
  base_selling_price?: number;
  carton_price?: number;
  carton_weight?: number;
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
  carton_price?: number;
  carton_weight?: number;
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
  bound_at?: Date;
  credential_id?: string;
  revoked?: boolean;
  save: () => Promise<unknown>;
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
  batchNumber?: string;
  batch_number?: string;
  saleUnit?: string;
  sale_unit?: string;
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

const POS_TAX_RATE_PCT = 7.5;
const POS_TAX_INCLUSIVE = true;
const POS_MAX_DISCOUNT_PCT = 50;

function nairaToKobo(naira: number) {
  return Math.round((Number(naira) || 0) * 100);
}

function isCartonUnit(unit?: string) {
  return String(unit || '').trim().toLowerCase().startsWith('carton');
}

@Injectable()
export class PosService {
  private pinAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    @InjectModel('User') private readonly userModel: Model<UserDoc>,
    @InjectModel('Role') private readonly roleModel: Model<RoleDoc>,
    @InjectModel('Hub') private readonly hubModel: Model<HubDoc>,
    @InjectModel('Product') private readonly productModel: Model<ProductDoc>,
    @InjectModel('Customer') private readonly customerModel: Model<any>,
    @InjectModel('Sale') private readonly saleModel: Model<any>,
    @InjectModel('StockLog') private readonly stockLogModel: Model<any>,
    @InjectModel('PosShift') private readonly shiftModel: Model<any>,
    @InjectModel('PosAssist') private readonly assistModel: Model<any>,
    @InjectModel('PosStockCount') private readonly countModel: Model<any>,
    @InjectModel('PosDevice') private readonly deviceModel: Model<DeviceDoc>,
    private readonly jwt: JwtService,
    private readonly passkeys: PosPasskeyService,
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
    if (!deviceId) throw new ForbiddenException('This till is not registered');
    const device = await this.deviceModel.findOne({ device_id: deviceId, revoked: { $ne: true } }).lean();
    if (!device) throw new ForbiddenException('This till is not registered');
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
      taxRatePct: POS_TAX_RATE_PCT,
      taxInclusive: POS_TAX_INCLUSIVE,
      maxDiscountPct: POS_MAX_DISCOUNT_PCT,
    };
  }

  async listLocations(deviceId?: string) {
    const id = String(deviceId || '').trim();
    if (!id) return { data: [] };
    const bound = await this.deviceModel.findOne({ device_id: id, revoked: { $ne: true } }).lean();
    if (!bound) return { data: [] };
    const hub = await this.hubModel.findById(bound.hub).lean();
    return { data: hub && hub.is_active !== false ? [this.mapLocation(hub)] : [] };
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

  private async getHubForUser(user: UserDoc, tillHubId: string) {
    // Resolve the device's location first: a manager can manage several locations,
    // and their default user.hub need not be this till's location.
    const hub = await this.getHub(tillHubId);
    if (refId(user.hub) === String(hub._id) || refId(hub.hub_manager) === String(user._id)) {
      return hub;
    }
    if ((user.role as RoleDoc | undefined)?.name === 'hub_manager') {
      throw new ForbiddenException('You cannot sign in to this till because you are not assigned to manage this location. Use a till at your assigned location or ask an administrator to check your location assignment.');
    }
    throw new ForbiddenException('Your staff account is not assigned to this till’s location. Ask a manager to check your location assignment.');
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
    assertion?: AuthenticationResponseJSON;
  }) {
    const pin = String(dto.pin ?? '').trim();
    if (!/^\d{4}$/.test(pin)) throw new BadRequestException('PIN must be 4 digits');

    const deviceId = String(dto.deviceId || '').trim();
    if (!deviceId) throw new ForbiddenException('This till is not registered');
    const registered = await this.deviceModel.findOne({ device_id: deviceId, revoked: { $ne: true } });
    if (!registered) throw new ForbiddenException('This till is not registered');
    if (registered.credential_id) {
      if (!dto.assertion) throw new ForbiddenException('This till must be unlocked with its passkey');
      await this.passkeys.verifyAssertion(deviceId, dto.assertion);
    }

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

    const hub = await this.getHubForUser(user, String(registered.hub));

    const role = user.role as RoleDoc | undefined;
    const mapped = this.toStaff(user, role?.name, String(hub._id));
    if (!mapped) throw new UnauthorizedException('Invalid PIN');
    if (!user.pin_hash) throw new UnauthorizedException('Till PIN is not set for this user');
    const ok = await bcrypt.compare(pin, user.pin_hash);
    if (!ok) throw new UnauthorizedException('Invalid PIN');

    if (!registered.credential_id) {
      registered.last_seen = new Date();
      if (dto.deviceLabel) registered.label = dto.deviceLabel;
      await registered.save();
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
    const data: Array<Record<string, unknown>> = [];
    for (const p of products) {
      const batches = await this.openBatches(p);
      const prices = batches.map((b) => b.unitPrice).filter((n) => n > 0);
      data.push({
        id: String(p._id),
        sku: p.sku,
        name: p.name,
        category: p.category || 'Other',
        price: nairaToKobo(p.base_selling_price || 0),
        cartonPrice: nairaToKobo(p.carton_price || 0),
        cartonWeight: Number(p.carton_weight) || 0,
        cost: nairaToKobo(p.avg_unit_cost || 0),
        unit: p.unit_of_measure || 'Units',
        stock: Math.max(0, (p.current_stock ?? 0) - (p.reserved_stock ?? 0)),
        onHandStock: p.current_stock ?? 0,
        reservedStock: p.reserved_stock ?? 0,
        trackStock: true,
        isActive: p.is_active !== false,
        batches,
      });
    }
    return { data };
  }

  async bindDevice(dto: { deviceId?: string; hubId?: string; storeId?: string; label?: string }) {
    const deviceId = String(dto.deviceId || '').trim();
    const hubId = dto.hubId || dto.storeId;
    if (!deviceId) throw new BadRequestException('deviceId is required');
    if (!hubId) throw new BadRequestException('hubId is required');
    const existing = await this.deviceModel.findOne({ device_id: deviceId, revoked: { $ne: true } });
    if (!existing) throw new ForbiddenException('This till is not registered');
    const hub = await this.getHub(hubId);
    if (String(existing.hub) !== String(hub._id)) {
      throw new ForbiddenException('This till is already bound to another location');
    }
    const now = new Date();
    existing.last_seen = now;
    // Enrollment owns the label; browser defaults must not overwrite it.
    await existing.save();
    const doc = existing;
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
    const device = await this.deviceModel.findOne({ device_id: deviceId, revoked: { $ne: true } });
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
      .sort({ date: 1, createdAt: 1, _id: 1 })
      .lean();
    type Batch = {
      batchNumber: string;
      date: Date;
      expiryDate?: Date;
      createdAt?: Date;
      quantityRemaining: number;
      unitCost: number;
      unitPrice: number;
      cartonPrice: number;
      cartonWeight: number;
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
            createdAt: log.createdAt,
            expiryDate: log.expiry_date ? new Date(log.expiry_date) : undefined,
            quantityRemaining: qty,
            unitCost: Number(log.unit_cost) || 0,
            unitPrice: Number(log.unit_price) || 0,
            cartonPrice: Number(log.carton_price) || 0,
            cartonWeight: Number(log.carton_weight) || 0,
          });
        }
      } else if (outbound) {
        let toDeduct = qty;
        const target = normalizeBatchNumber(log.batch_number);
        const ordered = [...batches].sort((a, b) => {
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
      return a.date.getTime() - b.date.getTime();
    });
  }

  private async openBatches(product: ProductDoc) {
    const rows = await this.computeRemainingBatches(product._id);
    const grouped = new Map<string, {
      batchNumber: string;
      quantityRemaining: number;
      unitPrice: number;
      cartonPrice: number;
      cartonWeight: number;
      unitCost: number;
      date: Date;
      createdAt?: Date;
    }>();
    for (const row of rows) {
      if (row.batchNumber.startsWith('UNLABELED-')) continue;
      const current = grouped.get(row.batchNumber);
      if (!current) {
        grouped.set(row.batchNumber, { ...row });
        continue;
      }
      current.quantityRemaining += row.quantityRemaining;
      if (row.date.getTime() >= current.date.getTime()) {
        current.date = row.date;
        current.unitPrice = row.unitPrice || current.unitPrice;
        current.unitCost = row.unitCost || current.unitCost;
        current.cartonPrice = row.cartonPrice || current.cartonPrice;
        current.cartonWeight = row.cartonWeight || current.cartonWeight;
      }
    }
    return [...grouped.values()].map((batch) => ({
      batchNumber: batch.batchNumber,
      date: batch.date,
      createdAt: batch.createdAt,
      quantityRemaining: Math.max(0, batch.quantityRemaining - Number(product.reserved_batches?.[Buffer.from(batch.batchNumber).toString('hex')] || 0)),
      unitPrice: nairaToKobo(product.base_selling_price || 0),
      cartonPrice: nairaToKobo(product.carton_price || 0),
      cartonWeight: Number(product.carton_weight) || 0,
      unitCost: nairaToKobo(batch.unitCost || product.avg_unit_cost || 0),
    }));
  }

  private async priceCart(hubId: string, payload: Record<string, any>, checkTotal: boolean) {
    const lines: SaleLineIn[] = payload.items || payload.lines || [];
    if (!lines.length) throw new BadRequestException('Sale has no items');
    const priced: Array<{
      product: ProductDoc;
      batchNumber: string;
      saleUnit: string;
      quantity: number;
      stockQuantity: number;
      unitPriceKobo: number;
      unitCostKobo: number;
      discountKobo: number;
      name: string;
    }> = [];
    let subtotal = 0;
    let lineDiscount = 0;
    const usedStock = new Map<string, number>();
    const usedByBatch = new Map<string, Record<string, number>>();
    for (const line of lines) {
      const productId = String(line.productId || line.product || '');
      if (!Types.ObjectId.isValid(productId)) throw new BadRequestException('Each line needs a product');
      const product = await this.productModel.findById(productId);
      if (!product || String(product.hub) !== hubId) {
        throw new ForbiddenException('A product on this sale is not stocked at this location');
      }
      const batches = await this.openBatches(product);
      const carton = isCartonUnit(product.unit_of_measure);
      const saleUnit = carton
        ? (line.saleUnit || line.sale_unit || '')
        : (line.saleUnit || line.sale_unit || product.unit_of_measure || 'Units');
      if (carton && saleUnit !== 'Carton' && saleUnit !== 'Kg') {
        throw new BadRequestException(`Select Carton or Kg for ${product.name}`);
      }
      const unitPriceKobo = nairaToKobo(saleUnit === 'Carton' ? product.carton_price || 0 : product.base_selling_price || 0);
      if (!unitPriceKobo) {
        throw new BadRequestException(`Set the SKU selling price for ${product.name}`);
      }
      const qty = this.lineQty(line);
      if (qty <= 0) throw new BadRequestException(`Quantity is required for ${product.name}`);
      let stockQuantity = qty;
      if (carton && saleUnit === 'Kg') {
        if (!(Number(product.carton_weight) > 0)) throw new BadRequestException('Set the SKU carton weight before selling by Kg');
        stockQuantity = qty / Number(product.carton_weight);
      }
      const already = usedStock.get(String(product._id)) || 0;
      if (Number(product.current_stock || 0) - Number(product.reserved_stock || 0) - already + 1e-9 < stockQuantity) throw new BadRequestException('Insufficient available stock for ' + product.name);
      const usedBatches = usedByBatch.get(String(product._id)) || {};
      let allocations;
      try {
        allocations = allocateFifo(batches.map(batch => ({ id: batch.batchNumber, batchNumber: batch.batchNumber, date: batch.date, createdAt: batch.createdAt,
          quantityRemaining: Math.max(0, batch.quantityRemaining - (usedBatches[batch.batchNumber] || 0)), unitCost: batch.unitCost })), stockQuantity);
      } catch { throw new BadRequestException('Insufficient available FIFO stock for ' + product.name); }
      usedStock.set(String(product._id), already + stockQuantity);
      for (const allocation of allocations) usedBatches[allocation.batch_number] = (usedBatches[allocation.batch_number] || 0) + allocation.quantity;
      usedByBatch.set(String(product._id), usedBatches);
      const gross = unitPriceKobo * qty;
      const discountKobo = Math.max(0, Math.round(Number(line.discount) || 0));
      const cap = Math.round(gross * (POS_MAX_DISCOUNT_PCT / 100));
      if (discountKobo > cap) {
        throw new BadRequestException(`Discount on ${product.name} is above ${POS_MAX_DISCOUNT_PCT}%`);
      }
      subtotal += gross;
      lineDiscount += discountKobo;
      let assignedDiscount = 0;
      for (let index = 0; index < allocations.length; index++) {
        const allocation = allocations[index];
        const allocatedDiscount = index === allocations.length - 1 ? discountKobo - assignedDiscount : Math.round(discountKobo * allocation.quantity / stockQuantity);
        assignedDiscount += allocatedDiscount;
        priced.push({ product, batchNumber: allocation.batch_number, saleUnit, quantity: qty * allocation.quantity / stockQuantity,
          stockQuantity: allocation.quantity, unitPriceKobo, unitCostKobo: allocation.unit_cost, discountKobo: allocatedDiscount, name: product.name });
      }
    }
    const afterLines = subtotal - lineDiscount;
    const orderDiscount = Math.max(0, Math.round(Number(payload.orderDiscount) || 0));
    const orderCap = Math.round(afterLines * (POS_MAX_DISCOUNT_PCT / 100));
    if (orderDiscount > orderCap) {
      throw new BadRequestException(`Cart discount is above ${POS_MAX_DISCOUNT_PCT}%`);
    }
    const net = afterLines - orderDiscount;
    const rate = POS_TAX_RATE_PCT / 100;
    const tax = rate > 0 && POS_TAX_INCLUSIVE ? Math.round(net - net / (1 + rate)) : Math.round(net * rate);
    const total = POS_TAX_INCLUSIVE || rate <= 0 ? net : net + tax;
    if (checkTotal && payload.total != null) {
      const claimed = Math.round(Number(payload.total) || 0);
      if (Math.abs(claimed - total) > 1) {
        throw new BadRequestException('The sale total does not match the batch price');
      }
    }
    return {
      subtotal,
      discount: lineDiscount + orderDiscount,
      orderDiscount,
      tax,
      taxRatePct: POS_TAX_RATE_PCT,
      taxInclusive: POS_TAX_INCLUSIVE,
      total,
      lines: priced,
    };
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
    batchNumber?: string,
    unitCost?: number,
  ) {
    const batch = normalizeBatchNumber(batchNumber);
    if (!batch) throw new BadRequestException(`Select a batch for ${product.name}`);
    const open = await this.openBatches(product);
    const match = open.find((row) => row.batchNumber === batch);
    if (!match || match.quantityRemaining < qty) {
      throw new BadRequestException(`Batch ${batch} does not have enough left for ${product.name}`);
    }
    await this.writeStockLog({
      product,
      type: 'SALE',
      quantity: -qty,
      unitCost: unitCost ?? koboToNaira(match.unitCost),
      unitPrice,
      referenceId: saleId,
      agentId,
      batchNumber: batch,
      notes: 'POS sale',
    });
    await this.syncSavedBatchBalances(product._id, batch);
    const fresh = await this.productModel.findById(product._id);
    const next = (Number(fresh?.current_stock) || 0) - qty;
    if (next < 0) throw new BadRequestException('Not enough available stock');
    await this.productModel.updateOne(
      { _id: product._id },
      { $set: { current_stock: next, last_stock_update: new Date() } },
    );
  }

  private async syncSavedBatchBalances(productId: Types.ObjectId, batchNumber: string) {
    const replay = await this.computeRemainingBatches(productId);
    let remaining = replay.filter(row => row.batchNumber === batchNumber).reduce((sum, row) => sum + row.quantityRemaining, 0);
    const rows = await this.stockLogModel.find({ item: productId, batch_number: batchNumber, quantity: { $gt: 0 }, type: { $in: ['PURCHASE', 'RETURN', 'TRANSFER', 'ADJUSTMENT'] } }).sort({ date: 1, createdAt: 1, _id: 1 });
    // Assign the remaining balance to the newest receipt first: the oldest was consumed first.
    for (const row of [...rows].reverse()) {
      const next = Math.min(Math.max(0, Number(row.quantity) || 0), remaining);
      remaining -= next;
      await this.stockLogModel.updateOne({ _id: row._id }, { $set: { quantity_remaining: next } });
    }
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
    if (batchNumber) await this.syncSavedBatchBalances(product._id, batchNumber);
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

  async quoteSale(user: PosJwtPayload, payload: Record<string, any>) {
    const hubId = this.assertJwtHub(user, payload.hubId || payload.storeId || user.hubId);
    if (!user.deviceId || (payload.deviceId && payload.deviceId !== user.deviceId)) {
      throw new ForbiddenException('Session is scoped to another till');
    }
    await this.requireBoundDevice(user.deviceId, hubId);
    const priced = await this.priceCart(hubId, payload, false);
    return {
      subtotal: priced.subtotal,
      discount: priced.discount,
      orderDiscount: priced.orderDiscount,
      tax: priced.tax,
      taxRatePct: priced.taxRatePct,
      taxInclusive: priced.taxInclusive,
      total: priced.total,
      lines: priced.lines.map((line) => ({
        productId: String(line.product._id),
        batchNumber: line.batchNumber,
        saleUnit: line.saleUnit,
        qty: line.quantity,
        unitPrice: line.unitPriceKobo,
        discount: line.discountKobo,
      })),
    };
  }

  async searchCustomers(user: PosJwtPayload, query?: string) {
    const hubId = this.assertJwtHub(user, user.hubId);
    const q = String(query || '').trim();
    const filter: Record<string, unknown> = { customer_location: oid(hubId, 'hubId') };
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { customer_name: { $regex: safe, $options: 'i' } },
        { customer_phone: { $regex: safe, $options: 'i' } },
      ];
    }
    const rows = await this.customerModel.find(filter).sort({ customer_name: 1 }).limit(10).lean();
    return {
      data: rows.map((row) => ({
        id: String(row._id),
        name: row.customer_name,
        phone: row.customer_phone,
      })),
    };
  }

  async createCustomer(user: PosJwtPayload, input: { name?: string; phone?: string }) {
    const hubId = this.assertJwtHub(user, user.hubId);
    const name = String(input.name || '').trim();
    const phone = String(input.phone || '').trim();
    if (!name) throw new BadRequestException('Customer name is required');
    if (!/^\+?\d{7,15}$/.test(phone)) throw new BadRequestException('Enter a phone number for this customer');
    const existing = await this.customerModel.findOne({ customer_phone: phone });
    if (existing) {
      if (String(existing.customer_location) !== hubId) {
        throw new BadRequestException('This phone already belongs to a customer at another location');
      }
      return { data: { id: String(existing._id), name: existing.customer_name, phone: existing.customer_phone } };
    }
    const created = await this.customerModel.create({
      customer_type: 'b2c',
      customer_name: name,
      customer_phone: phone,
      customer_location: oid(hubId, 'hubId'),
      assigned_agent: oid(user.sub, 'cashier'),
      added_by: oid(user.sub, 'cashier'),
      joined_date: new Date(),
    });
    return { data: { id: String(created._id), name: created.customer_name, phone: created.customer_phone } };
  }

  async inventoryTransaction<T>(work: () => Promise<T>): Promise<T> {
    if ((this.productModel.base as any).transactionAsyncLocalStorage?.getStore()?.session) return work();
    return this.productModel.db.transaction(work);
  }

  async lockPaymentProducts(payload: Record<string, any>) {
    const ids = [...new Set<string>((payload.items || payload.lines || []).map((line: any) => String(line.productId || line.product || '')))].sort();
    for (const id of ids) {
      if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid product');
      await fenceProduct(this.productModel, new Types.ObjectId(id));
    }
  }

  async reservePayment(user: PosJwtPayload, payload: Record<string, any>) {
    await this.lockPaymentProducts(payload);
    const priced = await this.priceCart(user.hubId, payload, false);
    const allocations: Record<string, { quantity: number; batches: Record<string, number> }> = {};
    for (const line of priced.lines) {
      const id = String(line.product._id);
      const a = allocations[id] ||= { quantity: 0, batches: {} };
      a.quantity += line.stockQuantity;
      const key = Buffer.from(line.batchNumber).toString('hex');
      a.batches[key] = (a.batches[key] || 0) + line.stockQuantity;
    }
    for (const [id, allocation] of Object.entries(allocations)) {
      const product = await this.productModel.findById(id);
      if (!product || Number(product.current_stock || 0) - Number(product.reserved_stock || 0) + 1e-8 < allocation.quantity) {
        throw new BadRequestException('Insufficient available stock for this payment');
      }
      const batches = await this.openBatches(product);
      for (const [key, qty] of Object.entries(allocation.batches)) {
        if ((batches.find(b => Buffer.from(b.batchNumber).toString('hex') === key)?.quantityRemaining || 0) + 1e-8 < qty) {
          throw new BadRequestException('Insufficient available batch stock for this payment');
        }
      }
      const increments: Record<string, number> = { reserved_stock: allocation.quantity };
      for (const [key, qty] of Object.entries(allocation.batches)) increments['reserved_batches.' + key] = qty;
      await this.productModel.updateOne({ _id: product._id }, { $inc: increments });
    }
    return { snapshot: JSON.parse(JSON.stringify(priced)), allocations };
  }

  async releasePayment(allocations: Record<string, { quantity: number; batches: Record<string, number> }>) {
    for (const id of Object.keys(allocations).sort()) {
      const a = allocations[id];
      const increments: Record<string, number> = { reserved_stock: -a.quantity };
      const filter: Record<string, any> = { _id: new Types.ObjectId(id), reserved_stock: { $gte: a.quantity - 1e-8 } };
      for (const [key, qty] of Object.entries(a.batches)) {
        increments['reserved_batches.' + key] = -qty;
        filter['reserved_batches.' + key] = { $gte: qty - 1e-8 };
      }
      const result = await this.productModel.updateOne(filter, { $inc: increments });
      if (result.modifiedCount !== 1) throw new BadRequestException('Reservation mismatch; manager reconciliation is required');
    }
  }

  async createSale(user: PosJwtPayload, payload: Record<string, any>, snapshot?: any): Promise<any> {
    return this.inventoryTransaction(async () => {
      await this.lockPaymentProducts(payload);
      return this.createSaleInTransaction(user, payload, snapshot);
    });
  }

  private async createSaleInTransaction(user: PosJwtPayload, payload: Record<string, any>, snapshot?: any) {
    const clientSaleId = String(payload.clientSaleId || payload.id || '').trim();
    if (!clientSaleId) throw new BadRequestException('clientSaleId is required');
    const hubId = this.assertJwtHub(user, payload.hubId || payload.storeId || user.hubId);
    if (!user.deviceId || (payload.deviceId && payload.deviceId !== user.deviceId)) {
      throw new ForbiddenException('Session is scoped to another till');
    }
    if (!snapshot) await this.requireBoundDevice(user.deviceId, hubId);

    const existing = await this.saleModel.findOne({ client_sale_id: clientSaleId }).lean();
    if (existing) {
      if (String(existing.hub) !== hubId || (existing.device_id && existing.device_id !== user.deviceId)) {
        throw new ForbiddenException('Transaction belongs to another location or till');
      }
      return { data: existing, idempotent: true };
    }

    if (!snapshot && await this.productModel.db.model('PosTransfer').exists({ client_sale_id: clientSaleId })) {
      throw new ConflictException('This sale is locked to an existing payment. Confirm or cancel that payment.');
    }
    const priced = snapshot || await this.priceCart(hubId, payload, true);
    const mappedItems = priced.lines.map((line) => ({
      product: line.product._id,
      product_name: line.name,
      quantity: line.quantity,
      unit: line.saleUnit,
      sale_unit: line.saleUnit,
      stock_quantity: line.stockQuantity,
      category: line.product.category,
      batch_number: line.batchNumber,
      unit_cost: koboToNaira(line.unitCostKobo),
      unit_price: koboToNaira(line.unitPriceKobo),
    }));
    let profit = 0;
    for (const line of priced.lines) {
      const revenue = koboToNaira(line.unitPriceKobo) * line.quantity - koboToNaira(line.discountKobo);
      const cost = koboToNaira(line.unitCostKobo) * line.stockQuantity;
      profit += revenue - cost;
    }

    const firstPay = (payload.payments || [])[0];
    const agentName = payload.cashierName || payload.agent_name || 'Cashier';
    const amount = Math.round(priced.total) / 100;
    const profitAmount = Math.round(profit * 100) / 100;
    const customerId = payload.customerId && Types.ObjectId.isValid(String(payload.customerId))
      ? oid(String(payload.customerId), 'customerId')
      : null;

    const created = await this.saleModel.create({
      customer: customerId,
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
      device_id: user.deviceId,
      source: 'pos',
      client_sale_id: clientSaleId,
    });

    for (const line of priced.lines) {
      const perStockKobo = line.saleUnit === 'Carton' && line.stockQuantity > 0
        ? Math.round((line.unitPriceKobo * line.quantity) / line.stockQuantity)
        : line.unitPriceKobo;
      await this.deductProductStock(
        line.product,
        line.stockQuantity,
        koboToNaira(perStockKobo),
        clientSaleId,
        user.sub,
        line.batchNumber,
        koboToNaira(line.unitCostKobo),
      );
    }

    return { data: created };
  }

  private async createReversal(user: PosJwtPayload, originalClientId: string, payload: Record<string, any>, kind: 'refund' | 'void') {
    return this.inventoryTransaction(() => this.createReversalInTransaction(user, originalClientId, payload, kind));
  }

  private async createReversalInTransaction(
    user: PosJwtPayload,
    originalClientId: string,
    payload: Record<string, any>,
    kind: 'refund' | 'void',
  ) {
    const hubId = this.assertJwtHub(user, payload.hubId || user.hubId);
    if (!user.deviceId || (payload.deviceId && payload.deviceId !== user.deviceId)) {
      throw new ForbiddenException('Session is scoped to another till');
    }
    await this.requireBoundDevice(user.deviceId, hubId);
    const reversalId = String(payload.reversalId || payload.id || '').trim();
    if (!reversalId) throw new BadRequestException('reversalId is required');

    const existing = await this.saleModel.findOne({ client_sale_id: reversalId }).lean();
    if (existing) {
      if (String(existing.hub) !== hubId || (existing.device_id && existing.device_id !== user.deviceId)) {
        throw new ForbiddenException('Transaction belongs to another location or till');
      }
      return { data: existing, idempotent: true };
    }

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
      device_id: user.deviceId,
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
    if (!user.deviceId || (payload.deviceId && payload.deviceId !== user.deviceId)) {
      throw new ForbiddenException('Session is scoped to another till');
    }
    await this.requireBoundDevice(user.deviceId, hubId);
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
    if (!user.deviceId || (payload.deviceId && payload.deviceId !== user.deviceId)) {
      throw new ForbiddenException('Session is scoped to another till');
    }
    await this.requireBoundDevice(user.deviceId, hubId);
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
    if (!user.deviceId || (payload.deviceId && payload.deviceId !== user.deviceId)) {
      throw new ForbiddenException('Session is scoped to another till');
    }
    await this.requireBoundDevice(user.deviceId, hubId);
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
