import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PosJwtGuard, PosUser, type PosJwtPayload } from './pos-auth';
import { TransactionsService } from './transactions.service';

@Controller('pos/transactions')
@UseGuards(PosJwtGuard)
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}
  @Get() list(
    @PosUser() user: PosJwtPayload,
    @Query() query: Record<string, string>,
  ) {
    return this.transactions.list(user, query);
  }
  @Get(':reference') get(
    @PosUser() user: PosJwtPayload,
    @Param('reference') reference: string,
  ) {
    return this.transactions.get(user, reference);
  }
}
