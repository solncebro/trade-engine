import crypto from 'crypto';

import {
  ReliableWebSocket,
  WebSocketLogger,
  WebSocketOpenContext,
  WebSocketStatus,
} from '@solncebro/websocket-engine';

import { TelegramNotifier } from './telegramNotifier';

import {
  BYBIT_RECV_WINDOW,
  BYBIT_TRADING_WEBSOCKET_URL,
} from '../constants/bybit';
import { logger } from '../core/logger';
import { EntityWithErrorText, ExchangeConfig, ExtensibleRecord } from '../types';

export interface BybitOrderParams extends ExtensibleRecord {
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  qty: string;
  price?: string;
  triggerPrice?: string;
  triggerDirection?: 1 | 2;
  category: 'linear' | 'spot' | 'option' | 'inverse';
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PostOnly';
}

export interface BybitOrderResult {
  orderId?: string;
  symbol?: string;
  side?: string;
  orderType?: string;
  qty?: string;
  price?: string;
  status?: string;
  createdTime?: number;
  updatedTime?: number;
}

export interface BybitResponseData extends EntityWithErrorText {
  orderId?: string;
}

export interface BybitWebSocketData
  extends ExtensibleRecord,
    BybitResponseData {}

export interface BybitWebSocketResponse {
  retCode?: number;
  retMsg?: string;
  isSuccess?: boolean;
  result?: BybitOrderResult;
  data?: BybitWebSocketData;
  op?: string;
  args?: (string | number)[];
  reqId?: string;
  topic?: string;
}

const BYBIT_TRADING_WEBSOCKET_NAME = 'Bybit Trading WebSocket';

const wsLogger: WebSocketLogger = {
  debug: msg => logger.debug(msg),
  info: msg => logger.info(msg),
  warn: msg => logger.warn(msg),
  error: msg => logger.error(msg),
  fatal: msg => logger.fatal(msg),
};

export class BybitNativeTradeWebSocket {
  private readonly config: ExchangeConfig;
  private readonly onNotify?: (message: string) => void | Promise<void>;
  private readonly websocketUrl: string;
  private reliableWs: ReliableWebSocket<BybitWebSocketResponse> | null = null;
  private isAuthenticated = false;
  private requestId = 1;

  constructor(config: ExchangeConfig, telegramNotifier?: TelegramNotifier, websocketUrl?: string) {
    this.config = config;
    this.websocketUrl = websocketUrl ?? BYBIT_TRADING_WEBSOCKET_URL;

    if (telegramNotifier) {
      this.onNotify = telegramNotifier.sendMessage.bind(telegramNotifier);
    }
  }

  private generateSignature(expires: number): string {
    const param = `GET/realtime${expires}`;

    return crypto
      .createHmac('sha256', this.config.secret)
      .update(param)
      .digest('hex');
  }

  private async authenticate(
    context: WebSocketOpenContext<BybitWebSocketResponse>
  ): Promise<void> {
    const expires = Date.now() + 10000;
    const signature = this.generateSignature(expires);

    const responsePromise = context.waitForMessage(msg => msg.op === 'auth', 10000);

    context.send({ op: 'auth', args: [this.config.apiKey, expires, signature] });

    const response = await responsePromise;

    if (response.retMsg !== 'OK' && response.retCode !== 0) {
      throw new Error(
        `Authentication failed: ${response.retMsg} (code: ${response.retCode})`
      );
    }
  }

  public connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let isFirstOpen = true;

      this.reliableWs = new ReliableWebSocket<BybitWebSocketResponse>({
        url: this.websocketUrl,
        label: BYBIT_TRADING_WEBSOCKET_NAME,
        logger: wsLogger,
        parseMessage: rawData => JSON.parse(rawData.toString()) as BybitWebSocketResponse,
        heartbeat: {
          buildPayload: () => ({ op: 'ping' }),
          isResponse: msg => msg.op === 'pong',
        },
        onOpen: async context => {
          try {
            await this.authenticate(context);
            this.isAuthenticated = true;

            if (isFirstOpen) {
              isFirstOpen = false;
              this.onNotify?.(`⛓️✅ ${BYBIT_TRADING_WEBSOCKET_NAME} authenticated`);
              resolve();
            } else {
              this.onNotify?.(`⛓️✅ ${BYBIT_TRADING_WEBSOCKET_NAME} reconnected and authenticated`);
            }
          } catch (error) {
            this.isAuthenticated = false;

            if (isFirstOpen) {
              isFirstOpen = false;
              this.reliableWs?.close();
              reject(error);
            }

            throw error;
          }
        },
        onMessage: message => {
          logger.debug({ message }, `${BYBIT_TRADING_WEBSOCKET_NAME} unhandled message`);
        },
        onNotify: this.onNotify,
      });
    });
  }

  public async createOrder(
    orderParams: BybitOrderParams
  ): Promise<BybitWebSocketResponse> {
    if (!this.isAuthenticated || !this.reliableWs) {
      throw new Error('WebSocket not authenticated');
    }

    const requestId = `req_${this.requestId++}_${Date.now()}`;
    const orderRequest = {
      reqId: requestId,
      header: {
        'X-BAPI-TIMESTAMP': Date.now().toString(),
        'X-BAPI-RECV-WINDOW': String(BYBIT_RECV_WINDOW),
      },
      op: 'order.create',
      args: [orderParams],
    };

    logger.debug({ orderRequest, requestId }, `Sending ${BYBIT_TRADING_WEBSOCKET_NAME} order request`);

    const responsePromise = this.reliableWs.waitForMessage(
      msg => msg.reqId === requestId,
      30000
    );

    this.reliableWs.sendToConnectedSocket(orderRequest);

    const response = await responsePromise;

    logger.debug({ response, requestId }, 'Order response received');

    return response;
  }

  public disconnect(): void {
    this.isAuthenticated = false;
    this.reliableWs?.close();
    this.reliableWs = null;
  }

  public isConnected(): boolean {
    return (
      this.isAuthenticated &&
      this.reliableWs?.getStatus() === WebSocketStatus.CONNECTED
    );
  }
}
