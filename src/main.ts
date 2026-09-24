import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.POS_FE_ORIGIN?.split(',') ?? ['http://localhost:3477'],
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: false, transform: true }));
  await app.listen(process.env.PORT ?? 3478);
}
bootstrap();
