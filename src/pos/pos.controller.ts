import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { PosJwtGuard, PosUser, type PosJwtPayload } from './pos-auth';
import { PosService } from './pos.service';
import { PosPasskeyService } from './pos-passkey.service';

@Controller('pos')
export class PosController {
  constructor(
    private readonly posService: PosService,
    private readonly passkeys: PosPasskeyService,
  ) {}

  @Get('locations')
  listLocations(@Query('deviceId') deviceId?: string) {
    return this.posService.listLocations(deviceId);
  }

  @Get('staff')
  listStaff(@Query('hubId') hubId?: string, @Query('storeId') storeId?: string, @Query('deviceId') deviceId?: string) {
    return this.posService.listStaff(hubId || storeId, deviceId);
  }

  @UseGuards(PosJwtGuard)
  @Post('staff')
  createStaff(
    @PosUser() user: PosJwtPayload,
    @Body() body: { full_name?: string; phone?: string; email?: string; pin?: string },
  ) {
    return this.posService.createCashier(user, body);
  }

  @UseGuards(PosJwtGuard)
  @Post('staff/:id/pin')
  resetStaffPin(@PosUser() user: PosJwtPayload, @Param('id') id: string) {
    return this.posService.resetCashierPin(user, id);
  }

  @Post('auth/pin')
  verifyPin(
    @Body()
    body: {
      hubId?: string;
      storeId?: string;
      userId?: string;
      username?: string;
      email?: string;
      pin: string;
      deviceId?: string;
      deviceLabel?: string;
      assertion?: AuthenticationResponseJSON;
    },
  ) {
    return this.posService.verifyPin(body);
  }

  @Get('catalog')
  catalog(
    @Query('hubId') hubId?: string,
    @Query('storeId') storeId?: string,
    @Query('deviceId') deviceId?: string,
  ) {
    return this.posService.catalog(hubId || storeId || '', deviceId);
  }

  @Get('devices/status')
  deviceStatus(@Query('deviceId') deviceId?: string) {
    return this.passkeys.deviceStatus(deviceId);
  }

  @Post('devices/register/options')
  registrationOptions(@Body() body: { deviceId?: string; code?: string }) {
    return this.passkeys.registrationOptions(String(body.deviceId || ''), String(body.code || ''));
  }

  @Post('devices/enroll')
  enroll(
    @Body() body: { deviceId?: string; code?: string; label?: string; response: RegistrationResponseJSON },
  ) {
    return this.passkeys.enroll({
      deviceId: String(body.deviceId || ''),
      code: String(body.code || ''),
      label: body.label,
      response: body.response,
    });
  }

  @Post('devices/authenticate/options')
  authenticationOptions(@Body() body: { deviceId?: string }) {
    return this.passkeys.authenticationOptions(String(body.deviceId || ''));
  }

  @Post('devices/bind')
  bindDevice(
    @Body() body: { deviceId?: string; hubId?: string; storeId?: string; label?: string },
  ) {
    return this.posService.bindDevice(body);
  }

  @UseGuards(PosJwtGuard)
  @Get('devices')
  listDevices(@PosUser() user: PosJwtPayload) {
    return this.posService.listDevices(user);
  }

  @UseGuards(PosJwtGuard)
  @Post('sales/quote')
  quoteSale(@PosUser() user: PosJwtPayload, @Body() body: Record<string, unknown>) {
    return this.posService.quoteSale(user, body);
  }

  @UseGuards(PosJwtGuard)
  @Get('customers')
  searchCustomers(@PosUser() user: PosJwtPayload, @Query('q') q?: string) {
    return this.posService.searchCustomers(user, q);
  }

  @UseGuards(PosJwtGuard)
  @Post('customers')
  createCustomer(@PosUser() user: PosJwtPayload, @Body() body: { name?: string; phone?: string }) {
    return this.posService.createCustomer(user, body);
  }

  @UseGuards(PosJwtGuard)
  @Post('sales')
  createSale(@PosUser() user: PosJwtPayload, @Body() body: Record<string, unknown>) {
    return this.posService.createSale(user, body);
  }

  @UseGuards(PosJwtGuard)
  @Post('sales/:clientSaleId/refund')
  refundSale(
    @PosUser() user: PosJwtPayload,
    @Param('clientSaleId') clientSaleId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.posService.refundSale(user, clientSaleId, body);
  }

  @UseGuards(PosJwtGuard)
  @Post('sales/:clientSaleId/void')
  voidSale(
    @PosUser() user: PosJwtPayload,
    @Param('clientSaleId') clientSaleId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.posService.voidSale(user, clientSaleId, body);
  }

  @UseGuards(PosJwtGuard)
  @Post('shifts')
  upsertShift(@PosUser() user: PosJwtPayload, @Body() body: Record<string, unknown>) {
    return this.posService.upsertShift(user, body);
  }

  @UseGuards(PosJwtGuard)
  @Get('shifts')
  listShifts(@PosUser() user: PosJwtPayload) {
    return this.posService.listShifts(user);
  }

  @UseGuards(PosJwtGuard)
  @Post('assists')
  upsertAssist(@PosUser() user: PosJwtPayload, @Body() body: Record<string, unknown>) {
    return this.posService.upsertAssist(user, body);
  }

  @UseGuards(PosJwtGuard)
  @Get('assists')
  listAssists(@PosUser() user: PosJwtPayload) {
    return this.posService.listAssists(user);
  }

  @UseGuards(PosJwtGuard)
  @Patch('assists/:clientAssistId')
  patchAssist(
    @PosUser() user: PosJwtPayload,
    @Param('clientAssistId') clientAssistId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.posService.patchAssist(user, clientAssistId, body);
  }

  @UseGuards(PosJwtGuard)
  @Post('stock-counts')
  upsertStockCount(@PosUser() user: PosJwtPayload, @Body() body: Record<string, unknown>) {
    return this.posService.upsertStockCount(user, body);
  }

  @UseGuards(PosJwtGuard)
  @Get('stock-counts')
  listStockCounts(@PosUser() user: PosJwtPayload) {
    return this.posService.listStockCounts(user);
  }
}
