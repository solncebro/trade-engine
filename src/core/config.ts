import dotenv from 'dotenv';

import { AppConfig } from '../types';

dotenv.config();

export class ConfigManager {
  public static getConfig(): AppConfig {
    const requiredEnvVars = [
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'TELEGRAM_APP_ID',
      'TELEGRAM_APP_HASH',
      'FIREBASE_PROJECT_ID',
      'FIREBASE_CLIENT_EMAIL',
      'FIREBASE_PRIVATE_KEY',
    ];

    const missingVarList = requiredEnvVars.filter(
      varName => !process.env[varName]
    );

    if (missingVarList.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingVarList.join(', ')}`
      );
    }

    const websocketUrlBase = process.env.WEBSOCKET_URL ?? '';
    const license = process.env.LICENSE ?? '';

    const websocketUrl =
      license && websocketUrlBase
        ? `${websocketUrlBase}/${license}`
        : 'ws://localhost:8765';

    return {
      license,
      websocketUrl,
      binance: {
        apiKey: process.env.BINANCE_API_KEY ?? '',
        secret: process.env.BINANCE_SECRET ?? '',
      },

      bybit: {
        apiKey: process.env.BYBIT_API_KEY ?? '',
        secret: process.env.BYBIT_SECRET ?? '',
      },

      telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN!,
        chatId: process.env.TELEGRAM_CHAT_ID!,
        signalChannelId: -1001124574831,
        apiId: parseInt(process.env.TELEGRAM_APP_ID!, 10),
        apiHash: process.env.TELEGRAM_APP_HASH!,
        appSession: process.env.TELEGRAM_APP_SESSION ?? '',
      },
    };
  }

  public static hasValidExchangeCredentials(
    exchangeName: 'binance' | 'bybit'
  ): boolean {
    const config = this.getConfig();
    const exchangeConfig = config[exchangeName];

    return !!(exchangeConfig.apiKey && exchangeConfig.secret);
  }
}
