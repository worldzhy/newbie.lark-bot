import {Injectable, OnModuleInit, OnModuleDestroy, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import * as Lark from '@larksuiteoapi/node-sdk';
import {LarkBotService} from './lark-bot.service';

@Injectable()
export class LarkWsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LarkWsService.name);
  private client: Lark.WSClient;

  constructor(
    private readonly configService: ConfigService,
    private readonly larkBotService: LarkBotService
  ) {}

  async onModuleInit() {
    const appId =
      this.configService.get<string>('LARK_APP_ID') || this.configService.get<string>('microservices.lark-bot.appId');
    const appSecret =
      this.configService.get<string>('LARK_APP_SECRET') ||
      this.configService.get<string>('microservices.lark-bot.appSecret');

    if (!appId || !appSecret) {
      this.logger.warn('Lark App ID or Secret is missing, skipping WebSocket client initialization.');
      return;
    }

    this.logger.log('Initializing Lark WebSocket Client...');

    try {
      this.client = new Lark.WSClient({
        appId,
        appSecret,
        loggerLevel: Lark.LoggerLevel.info,
      });

      await this.client.start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async data => {
            const message = data.message;
            if (!message) return;

            const chatType = message.chat_type;
            const mentions = message.mentions || [];

            // Filter: Only process messages that mention the bot in a group chat
            if (chatType === 'group' && (!mentions || mentions.length === 0)) {
              this.logger.debug(`[WS] Ignored group message without mentions: ${message.message_id}`);
              return;
            }

            const chatId = message.chat_id;
            const msgType = message.message_type || (message as any).msg_type;
            const parentId = message.parent_id;

            this.logger.log(`[WS] Received message: ${message.message_id} from chat: ${chatId}, parentId: ${parentId}`);

            if (msgType === 'text' || msgType === 'post') {
              let text = '';
              try {
                const content = JSON.parse(message.content);

                if (msgType === 'text') {
                  text = content.text;
                } else if (msgType === 'post') {
                  const postContent = content.content || [];
                  let extractedText = '';

                  let blocksToProcess: any[] = [];
                  if (Array.isArray(postContent)) {
                    blocksToProcess = postContent;
                  } else {
                    const langKey = postContent.zh_cn ? 'zh_cn' : Object.keys(postContent)[0];
                    if (langKey) {
                      blocksToProcess = postContent[langKey] || [];
                    }
                  }

                  for (const block of blocksToProcess) {
                    if (Array.isArray(block)) {
                      for (const element of block) {
                        if (element.tag === 'text') {
                          extractedText += element.text;
                        } else if (element.tag === 'at') {
                          extractedText += element.user_name ? `@${element.user_name}` : '@user';
                        } else if (element.tag === 'a') {
                          extractedText += element.text;
                        }
                      }
                      extractedText += '\n';
                    }
                  }

                  text = extractedText;
                }

                // Filter out @mentions (e.g., "@_user_1 ")
                if (text) {
                  text = text.replace(/^@\w+\s*/, '').trim();
                }

                this.logger.log(`[WS] Message content (cleaned): ${text}`);
              } catch (e) {
                this.logger.error(`[WS] Failed to parse message content: ${message.content}`, e);
                return; // Stop processing if parsing fails
              }

              try {
                // Delegate command processing to LarkBotService via webhook mock
                // We'll invoke the messageHandler directly if we could, but since we use handleWebhook, let's construct a mock body
                const mockWebhookBody = {
                  header: {event_type: 'im.message.receive_v1'},
                  event: {
                    message: {
                      ...message,
                      msg_type: msgType,
                    },
                    sender: data.sender,
                  },
                };
                await this.larkBotService.handleWebhook(mockWebhookBody as any);
              } catch (e) {
                this.logger.error('[WS] Error processing command', e);
              }
            }
          },
        }),
      });

      this.logger.log('Lark WebSocket Client started successfully.');
    } catch (error) {
      this.logger.error('Failed to start Lark WebSocket Client', error);
    }
  }

  async onModuleDestroy() {
    // There is no explicit stop method in the current SDK version for WSClient,
    // but typically we should handle cleanup if possible.
    // Assuming the SDK handles disconnection on process exit.
    this.logger.log('Lark WebSocket Client stopped.');
  }
}
