import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { PosPasskeyService } from './pos-passkey.service';
import { PosTransferService } from './pos-transfer.service';
import { PosJwtGuard } from './pos-auth';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { CreditRecordSchema, PosCheckoutSchema, PosPaymentAttemptSchema, PosProviderTransactionSchema, PosTerminalLockSchema, PosWebhookInboxSchema } from './schemas/checkout-models';
import {
  CustomerSchema,
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
  PosTillSequenceSchema,
  PosEnrollmentCodeSchema,
  PosShiftSchema,
  PosStockCountSchema,
  PosWebauthnChallengeSchema,
  PosTransferSchema,
} from './schemas/pos-models';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'User', schema: UserSchema },
      { name: 'Role', schema: RoleSchema },
      { name: 'Hub', schema: HubSchema },
      { name: 'Product', schema: ProductSchema },
      { name: 'Customer', schema: CustomerSchema },
      { name: 'Sale', schema: SaleSchema },
      { name: 'StockLog', schema: StockLogSchema },
      { name: 'PosShift', schema: PosShiftSchema },
      { name: 'PosAssist', schema: PosAssistSchema },
      { name: 'PosStockCount', schema: PosStockCountSchema },
      { name: 'PosDevice', schema: PosDeviceSchema },
      { name: 'PosTillSequence', schema: PosTillSequenceSchema },
      { name: 'PosEnrollmentCode', schema: PosEnrollmentCodeSchema },
      { name: 'PosWebauthnChallenge', schema: PosWebauthnChallengeSchema },
      { name: 'PosTransfer', schema: PosTransferSchema },
      { name: 'CreditRecord', schema: CreditRecordSchema },
      { name: 'PosCheckout', schema: PosCheckoutSchema },
      { name: 'PosPaymentAttempt', schema: PosPaymentAttemptSchema },
      { name: 'PosProviderTransaction', schema: PosProviderTransactionSchema },
      { name: 'PosTerminalLock', schema: PosTerminalLockSchema },
      { name: 'PosWebhookInbox', schema: PosWebhookInboxSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') || 'pos-dev-secret',
      }),
    }),
  ],
  controllers: [PosController, CheckoutController],
  providers: [PosService, PosPasskeyService, PosTransferService, PosJwtGuard, CheckoutService],
})
export class PosModule {}
