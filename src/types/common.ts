export interface ExtensibleRecord {
  [key: string]: unknown;
}

export interface Notifiable {
  onNotify: (message: string, isLogOnly?: boolean) => void | Promise<void>;
  onError: (customMessage: string, error: unknown) => void | Promise<void>;
}

