export interface TelegramMessageListenerArgs {
  apiId: number;
  apiHash: string;
  appSession: string;
}

export interface TelegramNotifierArgs {
  botToken: string;
  chatId: string;
}
