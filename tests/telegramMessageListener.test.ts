jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

interface FakeUserClient {
  start: jest.Mock;
  stop: jest.Mock;
  isConnected: jest.Mock;
  subscribe: jest.Mock;
  onNewMessage: ((message: unknown) => Promise<void>) | null;
  unsubscribe: jest.Mock;
}

const createFakeUserClient = (): FakeUserClient => {
  const fake: FakeUserClient = {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    unsubscribe: jest.fn(),
    onNewMessage: null,
    subscribe: jest.fn(),
  };

  fake.subscribe.mockImplementation((args: { onNewMessage: (message: unknown) => Promise<void> }) => {
    fake.onNewMessage = args.onNewMessage;

    return fake.unsubscribe;
  });

  return fake;
};

let fakeUserClient = createFakeUserClient();
const mockCreateUserClient = jest.fn((_args: unknown) => fakeUserClient);

jest.mock('@solncebro/telegram-engine', () => ({
  createUserClient: (args: unknown) => mockCreateUserClient(args),
}));

import { logger } from '../src/core/logger';
import { TelegramMessageListener } from '../src/services/telegramMessageListener';

const createPart = (id: number, senderId: string | undefined) => ({
  id,
  senderId: senderId === undefined ? undefined : { toString: () => senderId },
});

const createUserMessage = (chatId: string, partList: ReturnType<typeof createPart>[]) => ({
  chatId,
  partList,
  raw: partList[0],
});

describe('TelegramMessageListener (wrapper over telegram-engine user client)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fakeUserClient = createFakeUserClient();
  });

  it('builds the user client from the old constructor arguments', () => {
    new TelegramMessageListener({ apiId: 42, apiHash: 'hash', appSession: 'session' });

    expect(mockCreateUserClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiId: 42, apiHash: 'hash', sessionString: 'session', albumWaitMs: 0 })
    );
  });

  it('start() starts the client, subscribes and emits connected', async () => {
    const listener = new TelegramMessageListener({ apiId: 1, apiHash: 'h', appSession: 's' });
    const connectedListener = jest.fn();
    listener.on('connected', connectedListener);

    await listener.start();

    expect(fakeUserClient.start).toHaveBeenCalledTimes(1);
    expect(fakeUserClient.subscribe).toHaveBeenCalledTimes(1);
    expect(connectedListener).toHaveBeenCalledTimes(1);
    expect(listener.getIsConnected()).toBe(true);
  });

  it('start() failure emits error and rethrows', async () => {
    const failure = new Error('AUTH_KEY_UNREGISTERED');
    fakeUserClient.start.mockRejectedValue(failure);
    const listener = new TelegramMessageListener({ apiId: 1, apiHash: 'h', appSession: 's' });
    const errorListener = jest.fn();
    listener.on('error', errorListener);

    await expect(listener.start()).rejects.toBe(failure);
    expect(errorListener).toHaveBeenCalledWith(failure);
    expect(listener.getIsConnected()).toBe(false);
  });

  it('delivers every album part as its own message to handlers and the message event', async () => {
    const listener = new TelegramMessageListener({ apiId: 1, apiHash: 'h', appSession: 's' });
    const handler = jest.fn();
    const messageEventListener = jest.fn();
    listener.onMessage(handler);
    listener.on('message', messageEventListener);
    await listener.start();

    const partList = [createPart(10, '777'), createPart(11, '777')];
    await fakeUserClient.onNewMessage?.(createUserMessage('-1001', partList));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, { chatId: '-1001', senderId: '777', message: partList[0] });
    expect(handler).toHaveBeenNthCalledWith(2, { chatId: '-1001', senderId: '777', message: partList[1] });
    expect(messageEventListener).toHaveBeenCalledTimes(2);
  });

  it('skips a message without a sender, as before', async () => {
    const listener = new TelegramMessageListener({ apiId: 1, apiHash: 'h', appSession: 's' });
    const handler = jest.fn();
    listener.onMessage(handler);
    await listener.start();

    await fakeUserClient.onNewMessage?.(createUserMessage('-1001', [createPart(10, undefined)]));

    expect(handler).not.toHaveBeenCalled();
  });

  it('a failing handler does not stop the next one', async () => {
    const listener = new TelegramMessageListener({ apiId: 1, apiHash: 'h', appSession: 's' });
    const secondHandler = jest.fn();
    listener.onMessage(() => {
      throw new Error('handler boom');
    });
    listener.onMessage(secondHandler);
    await listener.start();

    await fakeUserClient.onNewMessage?.(createUserMessage('5', [createPart(1, '2')]));

    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith({ error: expect.any(Error) }, 'Error in message handler');
  });

  it('removeMessageHandler detaches a handler', async () => {
    const listener = new TelegramMessageListener({ apiId: 1, apiHash: 'h', appSession: 's' });
    const handler = jest.fn();
    listener.onMessage(handler);
    listener.removeMessageHandler(handler);
    await listener.start();

    await fakeUserClient.onNewMessage?.(createUserMessage('5', [createPart(1, '2')]));

    expect(handler).not.toHaveBeenCalled();
  });

  it('stop() unsubscribes, stops the client and emits disconnected', async () => {
    const listener = new TelegramMessageListener({ apiId: 1, apiHash: 'h', appSession: 's' });
    const disconnectedListener = jest.fn();
    listener.on('disconnected', disconnectedListener);
    await listener.start();

    listener.stop();

    expect(fakeUserClient.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fakeUserClient.stop).toHaveBeenCalledTimes(1);
    expect(disconnectedListener).toHaveBeenCalledTimes(1);
    expect(listener.getIsConnected()).toBe(false);
  });

  it('stop() before start() does not touch the client', () => {
    const listener = new TelegramMessageListener({ apiId: 1, apiHash: 'h', appSession: 's' });

    listener.stop();

    expect(fakeUserClient.stop).not.toHaveBeenCalled();
  });

  it('logs a new session string so the operator can save it', () => {
    new TelegramMessageListener({ apiId: 1, apiHash: 'h', appSession: '' });
    const clientArgs = mockCreateUserClient.mock.calls[0][0] as { onSessionChanged: (value: string) => void };

    clientArgs.onSessionChanged('new-session');

    expect(logger.info).toHaveBeenCalledWith('New session created. Save this session string:');
    expect(logger.info).toHaveBeenCalledWith('new-session');
  });
});
