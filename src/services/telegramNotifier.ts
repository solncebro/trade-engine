import {
  createBot,
  createBroadcaster,
  createSender,
  escapeMarkdownV2WithFormatting,
} from '@solncebro/telegram-engine';
import type { Broadcaster, LogFunction } from '@solncebro/telegram-engine';
import { Context, Telegraf } from 'telegraf';

import { logger } from '../core/logger';
import { TelegramNotifierArgs } from '../types/telegram';
import { SpecialCommandConfig } from '../types/telegramCommandHandler';

const normalizeChatIdList = (chatId: string | string[]): string[] => {
  const chatIdList = (Array.isArray(chatId) ? chatId : [chatId])
    .map(item => item.trim())
    .filter(item => item.length > 0);

  if (chatIdList.length === 0) {
    throw new Error('TelegramNotifier requires at least one chat id');
  }

  return chatIdList;
};

export class TelegramNotifier {
  private bot: Telegraf;
  private chatIdList: string[];
  private broadcaster: Broadcaster;
  private commandConfigList: SpecialCommandConfig[] = [];

  constructor(args: TelegramNotifierArgs) {
    const { botToken, chatId } = args;

    this.chatIdList = normalizeChatIdList(chatId);

    // Create the bot through telegram-engine's createBot so it gets the standard crash guard: one
    // failing handler can never abort long polling for the whole bot (see applyBotCrashGuard).
    this.bot = createBot({
      botToken,
      // botName is a label only — use the primary chat for back-compat with single-chat logs.
      botName: this.getChatId(),
      onError: (error, botName) => {
        logger.error(
          { error, botName },
          '[Telegram] Unhandled handler error — suppressed to keep polling alive'
        );
        // Also ping the chat so the user sees "it errored, not froze" without digging through logs.
        this.notifyHandlerError(error);
      },
    }).bot;

    // All sending/formatting/broadcasting is centralized in telegram-engine: a sender bound to this
    // bot, fanned out over every configured chat by the broadcaster. The notifier keeps no sender or
    // parse-mode logic of its own.
    const onLog: LogFunction = (message, data) =>
      logger.error(data ?? {}, `[Telegram] ${message}`);
    const sender = createSender({ getBot: () => this.bot, onLog });
    this.broadcaster = createBroadcaster({
      sender,
      recipientList: this.chatIdList,
      onLog,
    });
  }

  // Short, casual heads-up in the chat when a handler throws. Fire-and-forget: sendFormattedMessage
  // escapes the text and swallows its own send failures, so this can never re-crash the bot.
  private notifyHandlerError(error: unknown): void {
    const errorText = error instanceof Error ? error.message : String(error);
    const shortText =
      errorText.length > 200 ? `${errorText.slice(0, 200)}…` : errorText;

    void this.sendFormattedMessage(
      `⚠️ Oops — a button handler errored (the bot is still alive, not frozen):\n${shortText}`
    );
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
        await this.handleError(
          `Command ${config.command} failed`,
          context,
          error
        );
      }
    });
  }

  public async start(): Promise<void> {
    await this.setupMenuButton();
    // launch() is intentionally not awaited (polling runs for the process lifetime). Catch its
    // rejection so a transient getUpdates 409 (restart overlap with a previous instance's still-
    // open long-poll) does not surface as an unhandled rejection and crash the consumer.
    this.bot.launch({ dropPendingUpdates: true }).catch(error => {
      logger.error({ error }, 'Telegram bot polling stopped');
    });

    logger.info({ chatIdList: this.chatIdList }, 'Telegram bot started');
  }

  private isAuthorizedChat(context: Context): boolean {
    const chatId = context.chat?.id.toString();

    return chatId !== undefined && this.chatIdList.includes(chatId);
  }

  private async handleError(
    message: string,
    context: Context,
    error?: unknown
  ): Promise<void> {
    const replyMessage = `\u274c ${message}`;

    if (error) {
      logger.error({ error }, replyMessage);
    } else {
      logger.error(replyMessage);
    }

    await context.reply(replyMessage);
  }

  private async setupMenuButton(): Promise<void> {
    if (this.commandConfigList.length === 0) {
      return;
    }

    const commandList = this.commandConfigList.map(config => ({
      command: config.command,
      description: config.description,
    }));

    await this.bot.telegram.setMyCommands(commandList);
  }

  // Broadcast a message to every configured chat. Formatting is unified on MarkdownV2 via
  // telegram-engine's escaper (no legacy 'Markdown'): formatting markers are preserved while special
  // characters are escaped, so plain text, emoji and `*bold*` all render safely. Per-chat send
  // failures are isolated and logged inside the broadcaster — one dead chat never blocks the rest.
  private async broadcast(message: string): Promise<void> {
    await this.broadcaster.sendToAll(escapeMarkdownV2WithFormatting(message), true);
  }

  public async sendMessage(
    message: string,
    isLogOnly: boolean = false
  ): Promise<void> {
    try {
      if (!isLogOnly) {
        await this.broadcast(message);
      }

      logger.info(message);
    } catch (error) {
      logger.error({ error, message }, 'Failed to send Telegram message');
    }
  }

  public async sendFormattedMessage(
    message: string,
    isLogOnly: boolean = false
  ): Promise<void> {
    try {
      if (!isLogOnly) {
        await this.broadcast(message);
      }

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
      await this.sendFormattedMessage(telegramMessage);
    } catch (sendError) {
      logger.error(
        { error: sendError, message: telegramMessage },
        'Failed to send Telegram error message'
      );
    }
  }

  public getBot(): Telegraf {
    return this.bot;
  }

  public stop(): void {
    this.bot.stop();

    logger.info('Telegram bot stopped');
  }

  // Primary chat id (first in the list). Kept for back-compat with single-chat consumers.
  public getChatId(): string {
    return this.chatIdList[0];
  }

  // Every configured chat id. Consumers that broadcast their own messages (e.g. photos sent straight
  // through getBot()) fan out over this list.
  public getChatIdList(): string[] {
    return this.chatIdList;
  }
}
