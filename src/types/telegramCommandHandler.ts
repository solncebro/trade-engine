import { Context } from 'telegraf';

export type CommandHandler = (context: Context) => Promise<void>;

export type GenericObject = Record<string, unknown>;

export interface SpecialCommandConfig {
  command: string;
  description: string;
  handler: CommandHandler;
}

export interface SettingConfigBase<T = string> {
  key: T;
  label: string;
}

export interface NumericSettingConfig<T = string> extends SettingConfigBase<T> {
  suffix: string;
  emoji: string;
}

export interface BooleanSettingConfig<T = string> extends SettingConfigBase<T> {
  enabledEmoji: string;
  disabledEmoji: string;
}

export interface TelegramCommandHandlerConfig<T = GenericObject> {
  specialCommandList: SpecialCommandConfig[];
  numericSettingConfigList: NumericSettingConfig<keyof T>[];
  booleanSettingConfigList: BooleanSettingConfig<keyof T>[];
  settingsGetter: () => T;
  settingUpdater: (key: keyof T, value: unknown) => Promise<void>;
}
