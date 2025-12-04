import { ExchangeConfig } from '../types';

export class ConfigManager {
  public static validateRequiredEnvVars(requiredVarNameList: string[]): void {
    const missingVarList = requiredVarNameList.filter(
      varName => !process.env[varName]
    );

    if (missingVarList.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingVarList.join(', ')}`
      );
    }
  }

  public static hasValidExchangeCredentials(
    exchangeConfig: ExchangeConfig
  ): boolean {
    return !!(exchangeConfig.apiKey && exchangeConfig.secret);
  }
}
