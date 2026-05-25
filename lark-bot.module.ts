import {Module} from '@nestjs/common';
import {HttpModule} from '@nestjs/axios';
import {ConfigModule} from '@nestjs/config';
import {LarkBotController} from './lark-bot.controller';
import {LarkBotService} from './lark-bot.service';
import {LarkWsService} from './lark-ws.service';

@Module({
  imports: [HttpModule, ConfigModule],
  controllers: [LarkBotController],
  providers: [LarkBotService, LarkWsService],
  exports: [LarkBotService],
})
export class LarkBotModule {}
