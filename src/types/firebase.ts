export enum MarginType {
  ISOLATED = 'isolated',
  CROSS = 'cross',
}

export type FirebaseStrategySettingsValues = string[] | number | boolean;

export interface SettingChange<V, K = PropertyKey> {
  key: K;
  current: V;
  previous: V;
  isChanged: boolean;
}

export type FirebaseSettingChange<
  T extends Record<string, FirebaseStrategySettingsValues>,
  K extends keyof T = keyof T
> = SettingChange<T[K], K>;
