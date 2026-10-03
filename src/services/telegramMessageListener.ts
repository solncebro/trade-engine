import { EventEmitter } from 'events';

import { createUserClient } from '@solncebro/telegram-engine';
import type { TelegramUserMessage, UserClient } from '@solncebro/telegram-engine';

import { logger } from '../core/logger';
import type { TelegramMessageListenerArgs } from '../types/telegram';
import { ReadlineHelper } from '../utils/readline.utils';

export interface TelegramIncomingMessage {
  chatId: string;
  senderId: string;
  message: TelegramUserMessage['raw'];
}

export type TelegramMessageHandler = (
  message: TelegramIncomingMessage
) => void | Promise<void>;

// Album parts are handed out one by one, as before the migration; 0 keeps the delay to one tick.
const ALBUM_WAIT_MS = 0;

/**
 * @deprecated Use `createUserClient` from `@solncebro/telegram-engine` directly (album assembly,
 * edits and deletions, history, connection watchdog). This class is a thin compatibility wrapper
 * over it with the old names, methods and events ('message', 'connected', 'disconnected', 'error').
 */
export class TelegramMessageListener extends EventEmitter {
  private userClient: UserClient;
  private isStarted = false;
  private readlineHelper: ReadlineHelper | null = null;
  private messageHandlerList: TelegramMessageHandler[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(args: TelegramMessageListenerArgs) {
    super();

    const { apiId, apiHash, appSession } = args;

    this.userClient = createUserClient({
      apiId,
      apiHash,
      sessionString: appSession,
      albumWaitMs: ALBUM_WAIT_MS,
      loginPrompt: {
        askPhoneNumber: () => this.askQuestion('phone number ? '),
        askPassword: () => this.askQuestion('password? '),
        askPhoneCode: () => this.askQuestion('code ? '),
      },
      // The pre-migration listener printed a freshly created session so the operator could save it;
      // interactive login stays useless without that.
      onSessionChanged: sessionString => {
        logger.info('New session created. Save this session string:');
        logger.info(sessionString);
      },
      onLog: (level, message, data) => logger[level](data ?? {}, `[Telegram] ${message}`),
    });
  }

  private askQuestion(question: string): Promise<string> {
    this.readlineHelper ??= new ReadlineHelper();

    return this.readlineHelper.askQuestion(question);
  }

  public async start(): Promise<void> {
    try {
      await this.userClient.start();

      this.isStarted = true;
      this.unsubscribe = this.userClient.subscribe({
        onNewMessage: message => this.handleUserMessage(message),
      });

      logger.info('Telegram client started successfully');

      this.emit('connected');
    } catch (error) {
      logger.error({ error }, 'Failed to start Telegram client');

      this.emit('error', error);

      throw error;
    }
  }

  private async handleUserMessage(userMessage: TelegramUserMessage): Promise<void> {
    for (const part of userMessage.partList) {
      await this.handleMessagePart(userMessage.chatId, part);
    }
  }

  private async handleMessagePart(
    chatId: string,
    message: TelegramUserMessage['raw']
  ): Promise<void> {
    try {
      const senderIdValue = message.senderId?.toString();

      if (!senderIdValue || !chatId) {
        return;
      }

      const incomingMessage: TelegramIncomingMessage = {
        chatId,
        senderId: senderIdValue,
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
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (this.isStarted) {
      this.isStarted = false;
      this.userClient.stop().catch((error: unknown) => {
        logger.error({ error }, 'Error stopping Telegram client');
      });
    }

    this.readlineHelper?.close();
    this.readlineHelper = null;

    logger.info('Telegram client stopped');

    this.emit('disconnected');
  }

  public getIsConnected(): boolean {
    return this.isStarted && this.userClient.isConnected();
  }
}
