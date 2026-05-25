import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {HttpService} from '@nestjs/axios';
import {firstValueFrom} from 'rxjs';
import {GetChatHistoryDto, LarkWebhookDto, SendTextDto, SendCardDto} from './lark-bot.dto';

type MessageHandler = (
  chatId: string,
  text: string,
  userId?: string,
  parentId?: string,
  messageId?: string
) => Promise<void>;
type CardActionHandler = (payload: any) => Promise<any>;

@Injectable()
export class LarkBotService {
  private readonly logger = new Logger(LarkBotService.name);
  private tenantAccessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  private messageHandler?: MessageHandler;
  private cardActionHandler?: CardActionHandler;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {}

  public onMessageReceived(handler: MessageHandler) {
    this.messageHandler = handler;
  }

  public onCardActionReceived(handler: CardActionHandler) {
    this.cardActionHandler = handler;
  }

  /**
   * Fetches and caches the tenant access token from Lark
   * @returns {Promise<string>} The valid tenant access token
   */
  private async getTenantAccessToken(): Promise<string> {
    // Check if the token is already cached and not expired
    if (this.tenantAccessToken && Date.now() < this.tokenExpiresAt) {
      return this.tenantAccessToken;
    }

    const appId =
      this.configService.get<string>('LARK_APP_ID') || this.configService.get<string>('microservices.lark-bot.appId');
    const appSecret =
      this.configService.get<string>('LARK_APP_SECRET') ||
      this.configService.get<string>('microservices.lark-bot.appSecret');

    if (!appId || !appSecret) {
      throw new Error('Lark App ID or Secret is not configured');
    }

    try {
      // Fetch new tenant access token from Lark API
      const response = await firstValueFrom(
        this.httpService.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          app_id: appId,
          app_secret: appSecret,
        })
      );

      const {code, msg, tenant_access_token, expire} = response.data;

      if (code !== 0) {
        throw new Error(`Failed to get tenant access token: ${msg}`);
      }

      this.tenantAccessToken = tenant_access_token;
      // expire is in seconds, set expiration time to 5 minutes before actual expiration for safety
      this.tokenExpiresAt = Date.now() + (expire - 300) * 1000;

      return this.tenantAccessToken!;
    } catch (error) {
      this.logger.error('Error fetching tenant access token', error);
      throw error;
    }
  }

  /**
   * Fetches chat history from a Lark group
   * @param {GetChatHistoryDto} dto The request parameters for fetching history
   * @returns {Promise<any>} The chat message data from Lark
   */
  async getChatHistory(dto: GetChatHistoryDto) {
    const token = await this.getTenantAccessToken();

    const params: any = {
      container_id_type: 'chat',
      container_id: dto.chatId,
    };

    if (dto.startTime) params.start_time = dto.startTime;
    if (dto.endTime) params.end_time = dto.endTime;
    if (dto.pageToken) params.page_token = dto.pageToken;
    if (dto.pageSize) params.page_size = dto.pageSize;

    try {
      const response = await firstValueFrom(
        this.httpService.get('https://open.feishu.cn/open-apis/im/v1/messages', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          params,
        })
      );

      const {code, msg, data} = response.data;

      if (code !== 0) {
        throw new Error(`Failed to get chat history: ${msg}`);
      }

      return data;
    } catch (error) {
      this.logger.error('Error fetching chat history', error);
      throw error;
    }
  }

  /**
   * Handles Lark webhook callbacks
   * @param {LarkWebhookDto} body The webhook request body
   * @returns {Promise<any>} The response to Lark
   */
  async handleWebhook(body: LarkWebhookDto) {
    // 1. Handle URL verification challenge
    if (body.type === 'url_verification' || body.header?.event_type === 'url_verification') {
      this.logger.log('Received URL verification challenge');
      return {challenge: body.challenge};
    }

    // 2. Handle Encrypted Event
    if (body.encrypt) {
      this.logger.warn('Received encrypted event, decryption is not implemented yet.');
      return {code: 0, msg: 'success'};
    }

    // 3. Handle Card Action (User clicked a button)
    // Lark V1 card action does NOT have header.event_type. It just has "action" and "open_id" etc. at the root level.
    if (body.action && body.action.value) {
      this.logger.log('Received card action trigger');
      if (this.cardActionHandler) {
        return await this.cardActionHandler(body);
      }
      return {code: 0, msg: 'success'};
    }

    // 4. Handle Message Event
    if (body.header?.event_type === 'im.message.receive_v1') {
      const message = body.event?.message;
      if (!message) return {code: 0, msg: 'success'};

      const chatId = message.chat_id;
      const msgType = message.msg_type;
      const chatType = message.chat_type; // 'p2p' or 'group'
      const mentions = message.mentions || [];

      // Check if the bot is mentioned in a group chat
      if (chatType === 'group') {
        // If there are no mentions in a group chat, ignore the message
        if (!mentions || mentions.length === 0) {
          this.logger.debug(`Ignored group message without mentions: ${message.message_id}`);
          return {code: 0, msg: 'success'};
        }

        // We need to verify if the bot ITSELF is actually mentioned.
        // In Lark webhook events, the `mentions` array contains the users mentioned.
        // The bot usually has no `user_id` in its `id` object (or it's empty/undefined)
        // or it might use `tenant_key` to distinguish, or we can just check if any mention lacks a normal user_id,
        // or if it's explicitly '@all' (which bot also receives).
        // Since the bot might be added to a group with "receive all messages" permission,
        // we must strictly filter out messages where ONLY other people are mentioned.
        const isBotMentioned = mentions.some((mention: any) => {
          // If the mention is @all
          if (mention.id?.open_id === 'all' || mention.key === '@_all') {
            return true;
          }
          // The bot's own mention object typically doesn't have a valid `user_id`
          // (because it's an app, not a user), or we can check if it matches our app_id.
          // Another common pattern: if the mention key is '@_user_1' and there's only one mention,
          // but that's fragile. The most robust way without knowing our own bot ID is checking
          // if there is a mention that lacks a user_id.
          return !mention.id?.user_id;
        });

        if (!isBotMentioned) {
          this.logger.debug(`Ignored group message as bot was not specifically mentioned: ${message.message_id}`);
          return {code: 0, msg: 'success'};
        }
      }

      this.logger.log(`Received message event: ${message.message_id} from chat: ${chatId}`);

      if (msgType === 'text' || msgType === 'post') {
        let text = '';
        try {
          const content = JSON.parse(message.content);

          if (msgType === 'text') {
            text = content.text;
          } else if (msgType === 'post') {
            // For 'post' messages, extract text from the rich text content array
            const postContent = content.content || [];
            let extractedText = '';

            // In some Lark versions/webhooks, content.content is a 2D array directly: [[{tag: 'text', text: '...'}], [...]]
            // In others, it might be wrapped in language keys: { "zh_cn": [[...]], "en_us": [[...]] }

            let blocksToProcess: any[] = [];
            if (Array.isArray(postContent)) {
              // Direct 2D array format
              blocksToProcess = postContent;
            } else {
              // Language key format, default to zh_cn or first available
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
                    extractedText += element.text; // extract link text
                  }
                }
                extractedText += '\n'; // Add newline between blocks (paragraphs)
              }
            }

            text = extractedText;
          }

          // Replace user mentions (e.g. "@_user_2") with their actual names if available
          // And remove bot mentions completely to avoid confusing the LLM
          if (mentions && mentions.length > 0) {
            for (const mention of mentions) {
              if (mention.key) {
                // If it's the bot (usually has no user_id, or we can check other properties)
                // In Lark, if the mention object doesn't have a valid user_id in the 'id' field, it's likely the bot or an app
                const isBot = !mention.id?.user_id;

                if (isBot) {
                  // Completely remove the bot's mention from the text
                  text = text.replace(mention.key, '');
                } else if (mention.name) {
                  // Replace with actual user name
                  text = text.replace(mention.key, `@${mention.name}`);
                }
              }
            }
          }

          // Clean up any double spaces or leading/trailing whitespace left by removing mentions
          text = text.trim();

          this.logger.log(`Message content (cleaned): ${text}`);
        } catch (e) {
          this.logger.error(`Failed to parse message content: ${message.content}`, e);
          return {code: 0, msg: 'success'};
        }

        try {
          const parentId = message.parent_id;
          if (this.messageHandler) {
            // we try to pass open_id as userId, because sender_id.user_id might not be available
            // sender.sender_id usually contains union_id, user_id, open_id
            const userId =
              body.event?.sender?.sender_id?.open_id || message.sender?.sender_id?.open_id || 'unknown_user';
            await this.messageHandler(chatId, text, userId, parentId, message.message_id);
          }
        } catch (e) {
          this.logger.error('Error processing command from webhook', e);
        }
      }
    }

    // Always return success to acknowledge receipt
    return {code: 0, msg: 'success'};
  }

  // --- CRUD Methods for Controller ---

  /**
   * Sends a text message to a user or chat
   */
  async sendText(dto: SendTextDto) {
    const token = await this.getTenantAccessToken();

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          'https://open.feishu.cn/open-apis/im/v1/messages',
          {
            receive_id: dto.receiveId,
            msg_type: 'text',
            content: JSON.stringify({text: dto.text}),
          },
          {
            headers: {Authorization: `Bearer ${token}`},
            params: {receive_id_type: dto.receiveIdType || 'chat_id'},
          }
        )
      );

      const {code, msg, data} = response.data;
      if (code !== 0) {
        throw new Error(`Failed to send text message: ${msg}`);
      }
      return data;
    } catch (error) {
      this.logger.error('Error sending text message', error);
      throw error;
    }
  }

  /**
   * Sends a card message to a user or chat
   */
  async sendCard(dto: SendCardDto) {
    const token = await this.getTenantAccessToken();

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          'https://open.feishu.cn/open-apis/im/v1/messages',
          {
            receive_id: dto.receiveId,
            msg_type: 'interactive',
            content: JSON.stringify(dto.card),
          },
          {
            headers: {Authorization: `Bearer ${token}`},
            params: {receive_id_type: dto.receiveIdType || 'chat_id'},
          }
        )
      );

      const {code, msg, data} = response.data;
      if (code !== 0) {
        throw new Error(`Failed to send card message: ${msg}`);
      }
      return data;
    } catch (error) {
      this.logger.error('Error sending card message', error);
      throw error;
    }
  }

  async getMessageContent(messageId: string) {
    const token = await this.getTenantAccessToken();
    try {
      const response = await firstValueFrom(
        this.httpService.get(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
          headers: {Authorization: `Bearer ${token}`},
        })
      );

      const {code, msg, data} = response.data;
      if (code !== 0) {
        throw new Error(`Failed to get message content: ${msg}`);
      }
      return data.items[0];
    } catch (error) {
      this.logger.error(`Error fetching message content for ID: ${messageId}`, error);
      throw error;
    }
  }

  /**
   * Fetches all members of a specific chat group
   * @param chatId The ID of the chat group
   */
  async getChatMembers(chatId: string) {
    const token = await this.getTenantAccessToken();
    let members: any[] = [];
    let pageToken = '';
    let hasMore = true;

    try {
      while (hasMore) {
        const response = await firstValueFrom(
          this.httpService.get(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members`, {
            headers: {Authorization: `Bearer ${token}`},
            params: {
              member_id_type: 'open_id',
              page_size: 100,
              page_token: pageToken || undefined,
            },
          })
        );

        const {code, msg, data} = response.data;
        if (code !== 0) {
          throw new Error(`Failed to get chat members: ${msg}`);
        }

        members = members.concat(data.items);
        hasMore = data.has_more;
        pageToken = data.page_token;
      }
      return members;
    } catch (error) {
      this.logger.error(`Error fetching members for chat ID: ${chatId}`, error);
      throw error;
    }
  }

  /**
   * Adds a reaction (emoji) to a specific message
   * @param messageId The ID of the message to react to
   * @param emojiType The type of emoji (e.g., 'OK', 'THUMBSUP')
   */
  async addReaction(messageId: string, emojiType: string = 'OK') {
    const token = await this.getTenantAccessToken();
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`,
          {
            reaction_type: {
              emoji_type: emojiType,
            },
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
          }
        )
      );

      const {code, msg} = response.data;
      if (code !== 0) {
        this.logger.warn(`Failed to add reaction to message ${messageId}: ${msg}`);
      }
    } catch (error: any) {
      this.logger.warn(`Error adding reaction to message ${messageId}: ${error?.message}`);
      // We don't throw here because failing to add a reaction shouldn't break the main flow
    }
  }
}
