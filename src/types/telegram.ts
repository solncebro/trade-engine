export interface TelegramMessageListenerArgs {
  apiId: number;
  apiHash: string;
  appSession: string;
}

export interface TelegramNotifierArgs {
  botToken: string;
  // A single chat id, or a list of chat ids to broadcast every message to. A bare string
  // keeps full backward compatibility (treated as a one-element list).
  chatId: string | string[];
}
