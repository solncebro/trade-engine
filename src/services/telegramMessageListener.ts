import { EventEmitter } from 'events';

import { Api, TelegramClient } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { StringSession } from 'telegram/sessions';

import { logger } from '../core/logger';
import { ReadlineHelper } from '../utils/readline.utils';

export interface TelegramMessageListenerArgs {
  apiId: number;
  apiHash: string;
  appSession: string;
}

export interface TelegramIncomingMessage {
  chatId: string;
  senderId: string;
  message: Api.Message;
}

export type TelegramMessageHandler = (
  message: TelegramIncomingMessage
) => void | Promise<void>;

export class TelegramMessageListener extends EventEmitter {
  private client: TelegramClient;
  private isConnected = false;
  private readlineHelper: ReadlineHelper;
  private messageHandlerList: TelegramMessageHandler[] = [];

  constructor(args: TelegramMessageListenerArgs) {
    super();

    const { apiId, apiHash, appSession } = args;

    this.readlineHelper = new ReadlineHelper();

    const stringSession = new StringSession(appSession);
    this.client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });
  }

  public async start(): Promise<void> {
    try {
      await this.client.connect();

      const isAuthorized = await this.client.checkAuthorization();

      if (!isAuthorized) {
        await this.client.start({
          phoneNumber: async () =>
            await this.readlineHelper.askQuestion('phone number ? '),
          password: async () =>
            await this.readlineHelper.askQuestion('password? '),
          phoneCode: async () =>
            await this.readlineHelper.askQuestion('code ? '),
          onError: error => logger.error({ error }, 'Telegram client error'),
        });

        logger.info('New session created. Save this session string:');
        logger.info(this.client.session.save());
      }

      this.isConnected = true;

      this.client.addEventHandler(
        (event: NewMessageEvent) => this.handleMessage(event.message),
        new NewMessage()
      );

      logger.info('Telegram client started successfully');

      this.emit('connected');
    } catch (error) {
      logger.error({ error }, 'Failed to start Telegram client');

      this.emit('error', error);

      throw error;
    }
  }

  private async handleMessage(message: Api.Message): Promise<void> {
    try {
      const senderIdValue = message.senderId?.valueOf();
      const chatIdValue = message.chatId?.valueOf();

      if (!senderIdValue || !chatIdValue) {
        return;
      }

      const incomingMessage: TelegramIncomingMessage = {
        chatId: String(chatIdValue),
        senderId: String(senderIdValue),
        message,
      };

      logger.info(
        {
          chatId: incomingMessage.chatId,
          senderId: incomingMessage.senderId,
          messageId: message.id,
        },
        'Received Telegram message'
      );

      this.emit('message', incomingMessage);

      for (const handler of this.messageHandlerList) {
        try {
          await handler(incomingMessage);
        } catch (error) {
          logger.error({ error }, 'Error in message handler');
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error handling Telegram message');

      this.emit('error', error);
    }
  }

  public onMessage(handler: TelegramMessageHandler): void {
    this.messageHandlerList.push(handler);
  }

  public removeMessageHandler(handler: TelegramMessageHandler): void {
    const index = this.messageHandlerList.indexOf(handler);

    if (index > -1) {
      this.messageHandlerList.splice(index, 1);
    }
  }

  public stop(): void {
    try {
      if (this.isConnected) {
        this.client.disconnect();

        this.isConnected = false;
      }

      this.readlineHelper.close();

      logger.info('Telegram client stopped');

      this.emit('disconnected');
    } catch (error) {
      logger.error({ error }, 'Error stopping Telegram client');

      this.emit('error', error);
    }
  }

  public getIsConnected(): boolean {
    return this.isConnected;
  }
}
