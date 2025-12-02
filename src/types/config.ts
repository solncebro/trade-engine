export interface ExchangeConfig {
  apiKey: string;
  secret: string;
}

export interface AppConfig {
  license: string;
  websocketUrl: string;
  binance: ExchangeConfig;
  bybit: ExchangeConfig;

  telegram: {
    botToken: string;
    chatId: string;
    signalChannelId: number;
    apiId: number;
    apiHash: string;
    appSession: string;
  };
}