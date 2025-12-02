import { BybitNativeTradeWebSocket } from '../src/services/bybitNativeTradeWebSocket';
import { TelegramNotifier } from '../src/services/telegramNotifier';
import { ExchangeConfig } from '../src/types';

describe('BybitNativeTradeWebSocket', () => {
  const mockConfig: ExchangeConfig = {
    apiKey: 'test-api-key',
    secret: 'test-secret',
  };

  const mockSendMessage = jest.fn();
  const mockSendError = jest.fn();
  const mockTelegramNotifier = {
    sendMessage: mockSendMessage,
    sendError: mockSendError,
  } as unknown as TelegramNotifier;

  let bybitWebSocket: BybitNativeTradeWebSocket;

  beforeEach(() => {
    bybitWebSocket = new BybitNativeTradeWebSocket(mockConfig, mockTelegramNotifier);
  });

  afterEach(() => {
    if (bybitWebSocket) {
      bybitWebSocket.disconnect();
    }

    mockSendMessage.mockClear();
    mockSendError.mockClear();
  });

  test('should initialize with correct config', () => {
    expect(bybitWebSocket).toBeInstanceOf(BybitNativeTradeWebSocket);
    expect(bybitWebSocket.isConnected()).toBe(false);
  });

  test('should construct WebSocket instance', () => {
    const testWebSocket = new BybitNativeTradeWebSocket(mockConfig);

    expect(testWebSocket).toBeInstanceOf(BybitNativeTradeWebSocket);
  });

  test('should handle initialization correctly', () => {
    const testWebSocket = new BybitNativeTradeWebSocket(mockConfig);

    expect(testWebSocket).toBeInstanceOf(BybitNativeTradeWebSocket);
  });

  test('should handle disconnect gracefully', () => {
    bybitWebSocket.disconnect();

    expect(bybitWebSocket.isConnected()).toBe(false);
  });

  test('should initialize with TelegramNotifier', () => {
    const newWebSocket = new BybitNativeTradeWebSocket(mockConfig, mockTelegramNotifier);

    expect(newWebSocket).toBeInstanceOf(BybitNativeTradeWebSocket);
  });

  test('should initialize without TelegramNotifier', () => {
    const newWebSocket = new BybitNativeTradeWebSocket(mockConfig);

    expect(newWebSocket).toBeInstanceOf(BybitNativeTradeWebSocket);
  });
});
