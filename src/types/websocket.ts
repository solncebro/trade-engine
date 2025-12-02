export interface WebSocketMessage {
  sendTime?: number;
  scrapedTime: number;
  sourceTime: number | null;
  source: string;
  title?: string;
  id: string;
  time?: number;
  type?: string;
  tweet_time?: number;
  text?: string;
  pickup?: number;
  author?: {
    id: string;
    screen_name: string;
  };
}

export interface ConnectionStatusMessage {
  type: string;
  status: string;
  account_type: string;
  timestamp: string;
  filter_mode: string;
  allowed_sources: string[];
  license_key: string;
  expiration_date: string;
}

export interface ParsedSignal {
  symbolList: string[];
  isDelisting: boolean;
  hasStopWords: boolean;
  excludedSymbolList: string[];
  remainingSymbolList: string[];
  originalMessage: WebSocketMessage;
}