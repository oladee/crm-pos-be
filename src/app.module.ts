import mongoose from 'mongoose';
mongoose.set('transactionAsyncLocalStorage', true);
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PosModule } from './pos/pos.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri:
          config.get('NODE_ENV') === 'dev'
            ? config.get('MONGO_STRING_TEST')
            : config.get('MONGO_STRING_PROD'),
      }),
    }),
    PosModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
