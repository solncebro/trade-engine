import {
  buildCommandNameFromKey,
  parseYesNoArgument,
  validatePositiveNumber,
} from '@solncebro/telegram-engine';
import type { Context } from '@solncebro/telegram-engine';

import { TelegramNotifier } from './telegramNotifier';

import { logger } from '../core/logger';
import {
  BooleanSettingConfig,
  GenericObject,
  NumericSettingConfig,
  TelegramCommandHandlerConfig,
} from '../types/telegramCommandHandler';

interface TelegramCommandHandlerArgs<T = GenericObject> {
  telegramNotifier: TelegramNotifier;
  config: TelegramCommandHandlerConfig<T>;
}

export class TelegramCommandHandler<T = GenericObject> {
  private telegramNotifier: TelegramNotifier;
  private config: TelegramCommandHandlerConfig<T>;

  constructor(args: TelegramCommandHandlerArgs<T>) {
    this.telegramNotifier = args.telegramNotifier;
    this.config = args.config;

    this.registerCommands();
  }

  private registerCommands(): void {
    this.registerSpecialCommands();
    this.registerSettingCommands();
  }

  private registerSpecialCommands(): void {
    this.config.specialCommandList.forEach(commandConfig => {
      this.telegramNotifier.registerCommand(commandConfig);
    });
  }

  private registerSettingCommands(): void {
    this.config.booleanSettingConfigList.forEach(config => {
      this.registerBooleanSettingCommand(config);
    });

    this.config.numericSettingConfigList.forEach(config => {
      this.registerNumericSettingCommand(config);
    });
  }

  private registerBooleanSettingCommand(
    config: BooleanSettingConfig<keyof T>
  ): void {
    const command = buildCommandNameFromKey(String(config.key));

    this.telegramNotifier.registerCommand({
      command,
      description: `Toggle ${config.label}`,
      handler: async context => {
        await this.handleBooleanSetting(context, config, command);
      },
    });
  }

  private registerNumericSettingCommand(
    config: NumericSettingConfig<keyof T>
  ): void {
    const command = buildCommandNameFromKey(String(config.key));

    this.telegramNotifier.registerCommand({
      command,
      description: `Set ${config.label}`,
      handler: async context => {
        await this.handleNumericSetting(context, config, command);
      },
    });
  }

  private async handleBooleanSetting(
    context: Context,
    config: BooleanSettingConfig<keyof T>,
    command: string
  ): Promise<void> {
    const value = this.parseBooleanArgument(context);

    if (value === null) {
      await context.reply(`❌ Usage: /${command} yes/no`);

      return;
    }

    try {
      await this.config.settingUpdater(config.key, value);

      const emoji = value ? config.enabledEmoji : config.disabledEmoji;
      const status = value ? 'enabled' : 'disabled';
      const message = `${emoji} ${config.label} ${status}`;

      await context.reply(message);
    } catch (error) {
      await this.handleError(
        context,
        `Failed to update ${String(config.key)}`,
        error
      );
    }
  }

  private async handleNumericSetting(
    context: Context,
    config: NumericSettingConfig<keyof T>,
    command: string
  ): Promise<void> {
    const value = this.parseNumericArgument(context);

    if (value === null) {
      await context.reply(`❌ Usage: /${command} <value>`);

      return;
    }

    try {
      await this.config.settingUpdater(config.key, value);

      const message = `${config.emoji} ${config.label} set to ${value}`;

      await context.reply(message);
    } catch (error) {
      await this.handleError(
        context,
        `Failed to update ${String(config.key)}`,
        error
      );
    }
  }

  private parseBooleanArgument(context: Context): boolean | null {
    const argument = this.readFirstArgument(context);

    return argument === null ? null : parseYesNoArgument(argument);
  }

  private parseNumericArgument(context: Context): number | null {
    const argument = this.readFirstArgument(context);

    if (argument === null) {
      return null;
    }

    const numericValue = parseFloat(argument);

    return !isNaN(numericValue) && validatePositiveNumber(numericValue)
      ? numericValue
      : null;
  }

  // The token right after the command, split on single spaces as before: "/cmd  yes" (double
  // space) yields an empty argument and therefore the usage reply.
  private readFirstArgument(context: Context): string | null {
    const text =
      context.message && 'text' in context.message ? context.message.text : '';
    const argumentList = text.split(' ');

    return argumentList.length < 2 ? null : argumentList[1];
  }

  private async handleError(
    context: Context,
    message: string,
    error?: unknown
  ): Promise<void> {
    await context.reply(`❌ ${message}`);

    if (error) {
      logger.error({ error }, message);
    } else {
      logger.error(message);
    }
  }
}
