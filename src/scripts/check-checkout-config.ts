import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from '../app.module';
import { checkoutConfiguration } from '../pos/checkout-config';

async function main() {
  process.env.POS_PAYMENT_WORKER_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const config = checkoutConfiguration();
    const issues = [...config.errors];
    const db = app.get<Connection>(getConnectionToken());
    for (const [deviceId, mapping] of Object.entries(config.terminals)) {
      if (!mapping?.hubId) continue;
      const device = await db.model('PosDevice').findOne({ device_id: deviceId, hub: mapping.hubId, revoked: { $ne: true } }).lean();
      if (!device) issues.push(`Terminal mapping does not match an active enrolled till: ${deviceId}`);
      const hub = await db.model('Hub').findById(mapping.hubId).lean();
      if (!hub || (hub as any).is_active === false) issues.push(`Terminal mapping location is unavailable: ${deviceId}`);
    }
    const marker = await db.collection('pos_payment_rollout').findOne({ _id: 'reservations-v1' as any });
    if (marker?.ready !== true) issues.push('Inventory reservation rollout is not ready');
    console.log(JSON.stringify({ checkoutEnabled: true, moniepointEnabled: process.env.MONIEPOINT_ENABLED === 'true',
      accountCount: Object.keys(config.accounts).length, terminalCount: Object.keys(config.terminals).length, valid: issues.length === 0, issues }));
    if (issues.length) process.exitCode = 1;
  } finally { await app.close(); }
}
main().catch(() => { console.error('Configuration check could not connect or validate. Check deployment configuration; no credentials are printed.'); process.exitCode = 1; });
