import { Controller, ForbiddenException, Get, Query, UseGuards } from '@nestjs/common';
import { PspAuditService } from './psp-audit.service';
import { CheckoutService } from './checkout.service';
import { PosJwtGuard, PosUser, type PosJwtPayload } from './pos-auth';

@Controller('pos/payment-audit')
@UseGuards(PosJwtGuard)
export class PaymentAuditController {
  constructor(private readonly audit: PspAuditService, private readonly checkouts: CheckoutService) {}

  @Get()
  async list(@PosUser() user: PosJwtPayload, @Query() query: Record<string, string>) {
    await this.checkouts.actor(user);
    if (user.role !== 'manager') throw new ForbiddenException('Manager access required');
    return this.audit.list(user.hubId, query);
  }
}
