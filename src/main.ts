import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import { CheckoutService } from './pos/checkout.service';
import { attachPosLive } from './pos/live-gateway';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({
    origin: process.env.POS_FE_ORIGIN?.split(',') ?? ['http://localhost:3477'],
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: false, transform: true }));
  if (process.env.POS_LIVE_ENABLED === 'true') {
    await attachPosLive(app.getHttpServer(), app.get(getConnectionToken()), app.get(JwtService), app.get(CheckoutService));
  }
  await app.listen(process.env.PORT ?? 3478);
}
bootstrap();
