export type FirebaseStrategySettingsValues = string[] | number | boolean;

import {
  BooleanSettingConfig,
  NumericSettingConfig,
  SettingConfigBase,
} from './telegramCommandHandler';

export interface SettingChange<V> {
  key: string;
  current: V;
  previous: V;
  isChanged: boolean;
}

export interface FormatSettingMessageArgs<
  V extends FirebaseStrategySettingsValues,
> {
  setting: SettingChange<V>;
  booleanConfigList: BooleanSettingConfig[];
  numericConfigList: NumericSettingConfig[];
  arrayConfigList: SettingConfigBase[];
}
