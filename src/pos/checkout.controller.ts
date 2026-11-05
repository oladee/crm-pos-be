import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CheckoutService } from './checkout.service';
import { PosJwtGuard, type PosJwtPayload, PosUser } from './pos-auth';

@Controller('pos')
export class CheckoutController {
  constructor(private readonly checkouts: CheckoutService) {}

  @Post('webhooks/moniepoint/:accountKey')
  moniepoint(@Param('accountKey') key: string, @Req() req: RawBodyRequest<Request>) {
    return this.checkouts.receiveMoniepoint(key, req.rawBody?.toString('utf8') || '', req.headers);
  }

  @Get('checkouts/options') @UseGuards(PosJwtGuard)
  options(@PosUser() user: PosJwtPayload) { return this.checkouts.options(user); }

  @Get('checkouts/reviews') @UseGuards(PosJwtGuard)
  reviews(@PosUser() user: PosJwtPayload) { return this.checkouts.reviews(user); }

  @Get('checkouts') @UseGuards(PosJwtGuard)
  list(@PosUser() user: PosJwtPayload, @Query('before') before?: string) { return this.checkouts.list(user, before); }

  @Post('checkouts') @UseGuards(PosJwtGuard)
  create(@PosUser() user: PosJwtPayload, @Body() body: Record<string, unknown>) { return this.checkouts.create(user, body); }

  @Get('checkouts/:id') @UseGuards(PosJwtGuard)
  get(@PosUser() user: PosJwtPayload, @Param('id') id: string, @Query('refresh') refresh?: string) { return this.checkouts.get(user, id, refresh === '1'); }

  @Post('checkouts/:id/payment-attempts') @UseGuards(PosJwtGuard)
  attempt(@PosUser() user: PosJwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.checkouts.attempt(user, id, body); }

  @Post('checkouts/:id/confirm-received') @UseGuards(PosJwtGuard)
  manual(@PosUser() user: PosJwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.checkouts.manual(user, id, body); }

  @Post('checkouts/:id/cancel') @UseGuards(PosJwtGuard)
  cancel(@PosUser() user: PosJwtPayload, @Param('id') id: string) { return this.checkouts.cancel(user, id); }

  @Get('customers/:id/credits') @UseGuards(PosJwtGuard)
  credits(@PosUser() user: PosJwtPayload, @Param('id') id: string) { return this.checkouts.credits(user, id); }

  @Post('credit-collections') @UseGuards(PosJwtGuard)
  repay(@PosUser() user: PosJwtPayload, @Body() body: Record<string, unknown>) { return this.checkouts.create(user, body, true); }
}
