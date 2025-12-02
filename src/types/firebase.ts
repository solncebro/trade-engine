export interface FirebaseStrategySettings {
  isActiveModule: boolean;
  orderVolumeUsdt: number;
  excludedNotSymbolWordList: string[];
  stopWordList: string[];
  excludedSymbolList: string[];
  takeProfitPercent: number;
  stopBuyAfterPercent: number;
  isUpbitOnly: boolean;
  isOnlyOneSymbolAllowed: boolean;
  leverage: number;
}

export type FirebaseStrategySettingsValues = string[] | number | boolean;

export type SettingChange<T> = {
  key: keyof FirebaseStrategySettings;
  current: T;
  previous: T;
  isChanged: boolean;
};

export enum MarginType {
  ISOLATED = 'isolated',
  CROSS = 'cross',
}
