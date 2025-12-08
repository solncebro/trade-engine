import crypto from 'crypto';
import { EventEmitter } from 'events';

import WebSocket from 'ws';

import { TelegramNotifier } from './telegramNotifier';

import {
  BYBIT_RECV_WINDOW,
  BYBIT_TRADING_WEBSOCKET_URL,
} from '../constants/bybit';
import { logger } from '../core/logger';
import {
  BybitResponse,
  EntityWithErrorText,
  ExchangeConfig,
  ExtensibleRecord,
} from '../types';

const BYBIT_TRADING_WEBSOCKET_NAME = 'Bybit Trading WebSocket';

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

export interface BybitWebSocketResponse extends BybitResponse {
  isSuccess?: boolean;
  result?: BybitOrderResult;
  data?: BybitWebSocketData;
  op?: string;
  args?: (string | number)[];
  reqId?: string;
  topic?: string;
}

export class BybitNativeTradeWebSocket extends EventEmitter {
  private websocket: WebSocket | null = null;
  private config: ExchangeConfig;
  private isAuthenticated: boolean = false;
  private reconnectAttemptQuantity: number = 0;
  private maxReconnectAttemptQuantity: number = 5;
  private pingInterval: NodeJS.Timeout | null = null;
  private requestId: number = 1;
  private onNotify?: (message: string) => void | Promise<void>;
  private onError?: (message: string, error: unknown) => void | Promise<void>;

  constructor(config: ExchangeConfig, telegramNotifier?: TelegramNotifier) {
    super();
    this.config = config;

    if (telegramNotifier) {
      this.onNotify = telegramNotifier.sendMessage.bind(telegramNotifier);
      this.onError = telegramNotifier.sendError.bind(telegramNotifier);
    }
  }

  private generateSignature(expires: number): string {
    try {
      const param = `GET/realtime${expires}`;

      return crypto
        .createHmac('sha256', this.config.secret)
        .update(param)
        .digest('hex');
    } catch (error) {
      logger.error({ error, expires }, 'Failed to generate signature');
      throw error;
    }
  }

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        logger.info('BybitNativeTradeWebSocket connecting');
        this.websocket = new WebSocket(BYBIT_TRADING_WEBSOCKET_URL);

        this.websocket.on('open', () => {
          this.reconnectAttemptQuantity = 0;
          this.authenticate()
            .then(async () => {
              if (this.onNotify) {
                await this.onNotify(
                  `⛓️✅ ${BYBIT_TRADING_WEBSOCKET_NAME} authenticated`
                );
              }

              resolve();
            })
            .catch(async (error: Error) => {
              if (this.onNotify) {
                await this.onNotify(
                  `⛓️❌ ${BYBIT_TRADING_WEBSOCKET_NAME} authentification error\n${error.message}`
                );
              }

              reject();
            });
        });

        this.websocket.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.websocket.on('error', async (error: Error) => {
          if (this.onNotify) {
            await this.onNotify(
              `⛓️‍💥🔴 ${BYBIT_TRADING_WEBSOCKET_NAME} error: ${error.message}`
            );
          }

          reject(error);
        });

        this.websocket.on('close', async () => {
          if (this.onNotify) {
            await this.onNotify(
              `⛓️‍💥🟡 ${BYBIT_TRADING_WEBSOCKET_NAME} disconnected, reconnecting...`
            );
          }

          this.isAuthenticated = false;
          this.cleanup();
          this.scheduleReconnect();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private async authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      const expires = Date.now() + 10000;
      const signature = this.generateSignature(expires);

      const authRequest = {
        op: 'auth',
        args: [this.config.apiKey, expires, signature],
      };

      const timeoutId = setTimeout(() => {
        reject(new Error('Authentication timeout'));
      }, 10000);

      const authHandler = (response: BybitWebSocketResponse) => {
        if (response.op === 'auth') {
          clearTimeout(timeoutId);
          this.off('authenticated', authHandler);

          if (response.retMsg === 'OK' || response.retCode === 0) {
            this.isAuthenticated = true;
            this.startPingInterval();

            resolve();
          } else {
            reject(
              new Error(
                `Authentication failed: ${response.retMsg} (code: ${response.retCode})`
              )
            );
          }
        }
      };

      this.on('authenticated', authHandler);
      this.send(authRequest);
    });
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());
      logger.debug(
        { message },
        `${BYBIT_TRADING_WEBSOCKET_NAME} message received`
      );

      if (message.op === 'auth') {
        this.emit('authenticated', message);

        return;
      }

      if (message.op === 'pong') {
        return;
      }

      if (message.op === 'order.create' || message.topic === 'order') {
        this.emit('orderResponse', message);

        return;
      }

      this.emit('message', message);
    } catch (error) {
      logger.error(
        { error, data: data.toString() },
        'Failed to parse WebSocket message'
      );
    }
  }

  private send(data: Record<string, unknown>): void {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify(data));
    } else {
      throw new Error('WebSocket not connected');
    }
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        this.send({ op: 'ping' });
      }
    }, 20000);
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttemptQuantity >= this.maxReconnectAttemptQuantity) {
      logger.error('Max reconnection attempts reached');

      return;
    }

    const delay = Math.pow(2, this.reconnectAttemptQuantity) * 1000;
    this.reconnectAttemptQuantity++;

    logger.info(
      {
        attempt: this.reconnectAttemptQuantity,
        maxAttempts: this.maxReconnectAttemptQuantity,
        delay,
      },
      'Scheduling Bybit WebSocket reconnection'
    );

    setTimeout(() => {
      this.connect().catch(error => {
        logger.error({ error }, 'Reconnection failed');
      });
    }, delay);
  }

  public async createOrder(
    orderParams: BybitOrderParams
  ): Promise<BybitWebSocketResponse> {
    if (!this.isAuthenticated) {
      throw new Error('WebSocket not authenticated');
    }

    return new Promise((resolve, reject) => {
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

      const timeoutId = setTimeout(() => {
        this.off('orderResponse', responseHandler);
        reject(new Error('Order creation timeout'));
      }, 30000);

      const responseHandler = (response: BybitWebSocketResponse) => {
        logger.debug({ response, requestId }, 'Order response received');

        if (response.reqId === requestId) {
          clearTimeout(timeoutId);
          this.off('orderResponse', responseHandler);
          resolve(response);
        }
      };

      this.on('orderResponse', responseHandler);
      logger.debug(
        { orderRequest, requestId },
        `Sending ${BYBIT_TRADING_WEBSOCKET_NAME} order request`
      );
      this.send(orderRequest);
    });
  }

  public disconnect(): void {
    this.cleanup();

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
  }

  public isConnected(): boolean {
    return !!(
      this.websocket &&
      this.websocket.readyState === WebSocket.OPEN &&
      this.isAuthenticated
    );
  }
}
