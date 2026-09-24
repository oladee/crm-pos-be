import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { PosJwtGuard } from './pos-auth';
import {
  HubSchema,
  ProductSchema,
  RoleSchema,
  SaleSchema,
  StockLogSchema,
  UserSchema,
} from './schemas/crm-models';
import {
  PosAssistSchema,
  PosDeviceSchema,
  PosShiftSchema,
  PosStockCountSchema,
} from './schemas/pos-models';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'User', schema: UserSchema },
      { name: 'Role', schema: RoleSchema },
      { name: 'Hub', schema: HubSchema },
      { name: 'Product', schema: ProductSchema },
      { name: 'Sale', schema: SaleSchema },
      { name: 'StockLog', schema: StockLogSchema },
      { name: 'PosShift', schema: PosShiftSchema },
      { name: 'PosAssist', schema: PosAssistSchema },
      { name: 'PosStockCount', schema: PosStockCountSchema },
      { name: 'PosDevice', schema: PosDeviceSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') || 'pos-dev-secret',
      }),
    }),
  ],
  controllers: [PosController],
  providers: [PosService, PosJwtGuard],
})
export class PosModule {}
