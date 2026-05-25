import {Controller, Post, Body, UseGuards, HttpCode, HttpStatus} from '@nestjs/common';
import {AuthGuard} from '@nestjs/passport';
import {ApiTags, ApiOperation, ApiBearerAuth} from '@nestjs/swagger';
import {LarkBotService} from './lark-bot.service';
import {GetChatHistoryDto, LarkWebhookDto, SendTextDto} from './lark-bot.dto';

@ApiTags('Lark Bot')
@Controller('lark-bot')
export class LarkBotController {
  constructor(private readonly larkBotService: LarkBotService) {}

  @Post('history')
  @ApiOperation({summary: 'Get chat history from Lark group'})
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  async getChatHistory(@Body() dto: GetChatHistoryDto) {
    return await this.larkBotService.getChatHistory(dto);
  }

  @Post('send-text')
  @ApiOperation({summary: 'Send a text message to a user or group'})
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  async sendText(@Body() dto: SendTextDto) {
    return await this.larkBotService.sendText(dto);
  }

  @Post('webhook')
  @ApiOperation({summary: 'Lark Webhook Callback'})
  @HttpCode(HttpStatus.OK)
  async webhook(@Body() dto: LarkWebhookDto) {
    return await this.larkBotService.handleWebhook(dto);
  }
}
