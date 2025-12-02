import { Context, Telegraf } from 'telegraf';

import { logger } from '../core/logger';
import { TelegramNotifierArgs } from '../types/telegram';
import { SpecialCommandConfig } from '../types/telegramCommandHandler';

export class TelegramNotifier {
  private bot: Telegraf;
  private chatId: string;
  private commandConfigList: SpecialCommandConfig[] = [];

  constructor(args: TelegramNotifierArgs) {
    const { botToken, chatId } = args;

    this.bot = new Telegraf(botToken);
    this.chatId = chatId;
  }

  public registerCommand(config: SpecialCommandConfig): void {
    this.commandConfigList.push(config);

    this.bot.command(config.command, async context => {
      if (!this.isAuthorizedChat(context)) {
        return;
      }

      try {
        await config.handler(context);
      } catch (error) {
        await this.handleError(`Command ${config.command} failed`, context, error);
      }
    });
  }

  public async start(): Promise<void> {
    await this.setupMenuButton();
    this.bot.launch();

    logger.info({ chatId: this.chatId }, 'Telegram bot started');
  }

  private isAuthorizedChat(context: Context): boolean {
    return context.chat?.id.toString() === this.chatId;
  }

  private async handleError(message: string, context: Context, error?: unknown): Promise<void> {
    const replyMessage = `\u274c ${message}`;

    if (error) {
      logger.error({ error }, replyMessage);
    } else {
      logger.error(replyMessage);
    }

    await context.reply(replyMessage);
  }

  private async setupMenuButton(): Promise<void> {
    const commandList = this.commandConfigList.map(config => ({
      command: config.command,
      description: config.description,
    }));

    await this.bot.telegram.setMyCommands(commandList);
  }

  public async sendMessage(message: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
      });

      logger.info(message);
    } catch (error) {
      logger.error({ error, message }, 'Failed to send Telegram message');
    }
  }

  public async sendError(customMessage: string, error: unknown): Promise<void> {
    logger.error({ error }, customMessage);

    const errorMessage =
      error instanceof Error
        ? `${error.message}${error.stack ? `\n\nStack:\n${error.stack}` : ''}`
        : String(error);
    const telegramMessage = `\u274c APPLICATION ERROR:\n${customMessage}\n\n${errorMessage}`;

    try {
      await this.sendMessage(telegramMessage);
    } catch (sendError) {
      logger.error(
        { error: sendError, message: telegramMessage },
        'Failed to send Telegram error message'
      );
    }
  }

  public stop(): void {
    this.bot.stop();

    logger.info('Telegram bot stopped');
  }

  public getChatId(): string {
    return this.chatId;
  }
}
