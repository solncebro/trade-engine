// Characterization of TelegramNotifier's observable behaviour (commands, access, start/stop, error
// texts). Written against the pre-migration implementation and kept green after moving the notifier
// onto telegram-engine's building blocks: consumers (rubber, ma-chaser, ma-bounce, coin-listing,
// volume-breaker) must not notice the switch.

type CommandMiddleware = (context: FakeContext, next: () => Promise<void>) => Promise<void> | void;

interface FakeContext {
  chat?: { id: number };
  updateType: string;
  reply: jest.Mock;
  message?: { text: string };
}

interface FakeBot {
  commandMiddlewareListByName: Map<string, CommandMiddleware[]>;
  command: jest.Mock;
  catch: jest.Mock;
  launch: jest.Mock;
  stop: jest.Mock;
  telegram: { sendMessage: jest.Mock; setMyCommands: jest.Mock };
}

const createFakeBot = (): FakeBot => {
  const commandMiddlewareListByName = new Map<string, CommandMiddleware[]>();

  return {
    commandMiddlewareListByName,
    command: jest.fn((name: string, ...middlewareList: CommandMiddleware[]) => {
      commandMiddlewareListByName.set(name, middlewareList);
    }),
    catch: jest.fn(),
    launch: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    telegram: {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
      setMyCommands: jest.fn().mockResolvedValue(true),
    },
  };
};

let fakeBot: FakeBot = createFakeBot();
let capturedCreateBotOnError: ((error: unknown, botName: string) => void) | undefined;

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@solncebro/telegram-engine', () => {
  const actual = jest.requireActual('@solncebro/telegram-engine');

  return {
    ...actual,
    createBot: jest.fn((args: { botName: string; onError?: (error: unknown, botName: string) => void }) => {
      capturedCreateBotOnError = args.onError;

      return {
        bot: fakeBot,
        botName: args.botName,
        launch: jest.fn(),
        stop: jest.fn(async (reason?: string) => fakeBot.stop(reason)),
      };
    }),
  };
});

import { logger } from '../src/core/logger';
import { TelegramNotifier } from '../src/services/telegramNotifier';

const createContext = (chatId: number | undefined, text = ''): FakeContext => ({
  chat: chatId === undefined ? undefined : { id: chatId },
  updateType: 'message',
  reply: jest.fn().mockResolvedValue(undefined),
  message: { text },
});

// Runs the middleware chain registered for a command the way Telegraf would.
const runCommand = async (name: string, context: FakeContext): Promise<void> => {
  const middlewareList = fakeBot.commandMiddlewareListByName.get(name) ?? [];

  const runAt = async (index: number): Promise<void> => {
    const middleware = middlewareList[index];

    if (middleware === undefined) {
      return;
    }

    await middleware(context, () => runAt(index + 1));
  };

  await runAt(0);
};

const flushPromises = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('TelegramNotifier behaviour', () => {
  beforeEach(() => {
    fakeBot = createFakeBot();
    capturedCreateBotOnError = undefined;
    jest.clearAllMocks();
  });

  it('runs a registered command for an allowed chat', async () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: ['111', '222'] });
    const handler = jest.fn().mockResolvedValue(undefined);

    notifier.registerCommand({ command: 'status', description: 'Status', handler });
    const context = createContext(222, '/status');
    await runCommand('status', context);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(context);
  });

  it('registers the command handler immediately, not at start()', () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });

    notifier.registerCommand({ command: 'ping', description: 'Ping', handler: jest.fn() });

    expect(fakeBot.command).toHaveBeenCalledTimes(1);
    expect(fakeBot.command.mock.calls[0][0]).toBe('ping');
  });

  it('silently ignores a command from a chat outside the list (no reply, handler not called)', async () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });
    const handler = jest.fn().mockResolvedValue(undefined);

    notifier.registerCommand({ command: 'status', description: 'Status', handler });
    const foreignContext = createContext(999, '/status');
    await runCommand('status', foreignContext);
    const chatlessContext = createContext(undefined, '/status');
    await runCommand('status', chatlessContext);

    expect(handler).not.toHaveBeenCalled();
    expect(foreignContext.reply).not.toHaveBeenCalled();
    expect(chatlessContext.reply).not.toHaveBeenCalled();
  });

  it('replies "❌ Command <name> failed" and logs when the handler throws', async () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });
    const failure = new Error('boom');

    notifier.registerCommand({
      command: 'status',
      description: 'Status',
      handler: jest.fn().mockRejectedValue(failure),
    });
    const context = createContext(111, '/status');
    await runCommand('status', context);

    expect(context.reply).toHaveBeenCalledWith('❌ Command status failed');
    expect(logger.error).toHaveBeenCalledWith({ error: failure }, '❌ Command status failed');
  });

  it('start() publishes the registered commands, then launches polling dropping pending updates', async () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });

    notifier.registerCommand({ command: 'a', description: 'A', handler: jest.fn() });
    notifier.registerCommand({ command: 'b', description: 'B', handler: jest.fn() });
    await notifier.start();

    expect(fakeBot.telegram.setMyCommands).toHaveBeenCalledWith([
      { command: 'a', description: 'A' },
      { command: 'b', description: 'B' },
    ]);
    expect(fakeBot.launch).toHaveBeenCalledWith({ dropPendingUpdates: true });
    expect(fakeBot.telegram.setMyCommands.mock.invocationCallOrder[0]).toBeLessThan(
      fakeBot.launch.mock.invocationCallOrder[0]
    );
  });

  it('start() without commands does not touch the command menu', async () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });

    await notifier.start();

    expect(fakeBot.telegram.setMyCommands).not.toHaveBeenCalled();
    expect(fakeBot.launch).toHaveBeenCalledTimes(1);
  });

  it('start() does not reject when polling stops with an error (409 on restart overlap)', async () => {
    fakeBot.launch.mockRejectedValue(new Error('409: Conflict'));
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });

    await expect(notifier.start()).resolves.toBeUndefined();
    await flushPromises();

    expect(logger.error).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      'Telegram bot polling stopped'
    );
  });

  it('stop() stops the bot', () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });

    notifier.stop();

    expect(fakeBot.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() of a bot that never launched logs instead of throwing', async () => {
    fakeBot.stop.mockImplementation(() => {
      throw new Error('Bot is not running!');
    });
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });

    expect(() => notifier.stop()).not.toThrow();
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith({ error: expect.any(Error) }, 'Telegram bot stop failed');
  });

  it('logs a foreign chat once (telegram-engine access guard)', async () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });

    notifier.registerCommand({ command: 'status', description: 'Status', handler: jest.fn() });
    await runCommand('status', createContext(999));
    await runCommand('status', createContext(999));

    const foreignWarnList = (logger.warn as jest.Mock).mock.calls.filter(
      call => call[1] === '[Telegram] Update from a chat outside the allow-list ignored'
    );

    expect(foreignWarnList).toHaveLength(1);
    expect(foreignWarnList[0][0]).toEqual(expect.objectContaining({ chatId: '999' }));
  });

  it('getBot() returns the underlying Telegraf bot', () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });

    expect(notifier.getBot()).toBe(fakeBot);
  });

  it('sendMessage with isLogOnly only logs', async () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });

    await notifier.sendMessage('quiet', true);
    await notifier.sendFormattedMessage('quiet too', true);

    expect(fakeBot.telegram.sendMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('quiet');
    expect(logger.info).toHaveBeenCalledWith('quiet too');
  });

  it('sendError logs and broadcasts "❌ APPLICATION ERROR" with message and stack', async () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: ['111', '222'] });
    const failure = new Error('disk full');
    failure.stack = 'Error: disk full\n    at x';

    await notifier.sendError('Journal flush', failure);

    expect(logger.error).toHaveBeenCalledWith({ error: failure }, 'Journal flush');
    expect(fakeBot.telegram.sendMessage).toHaveBeenCalledTimes(2);

    const sentText: string = fakeBot.telegram.sendMessage.mock.calls[0][1];

    expect(sentText).toBe(
      '❌ APPLICATION ERROR:\nJournal flush\n\ndisk full\n\nStack:\nError: disk full\n    at x'
    );
    expect(fakeBot.telegram.sendMessage.mock.calls[0][2]).toEqual(
      expect.objectContaining({ parse_mode: 'MarkdownV2' })
    );
  });

  it('sendError with a non-Error value stringifies it', async () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '111' });

    await notifier.sendError('Oops', 'plain failure');

    expect(fakeBot.telegram.sendMessage.mock.calls[0][1]).toBe(
      '❌ APPLICATION ERROR:\nOops\n\nplain failure'
    );
  });

  it('a crashed handler is reported to every chat with a short heads-up', async () => {
    new TelegramNotifier({ botToken: 't', chatId: ['111', '222'] });

    expect(capturedCreateBotOnError).toBeDefined();
    capturedCreateBotOnError?.(new Error('x'.repeat(250)), '111');
    await flushPromises();

    expect(fakeBot.telegram.sendMessage).toHaveBeenCalledTimes(2);

    const sentText: string = fakeBot.telegram.sendMessage.mock.calls[0][1];

    expect(sentText.startsWith('⚠️ Oops — a button handler errored')).toBe(true);
    expect(sentText).toContain(`${'x'.repeat(200)}…`);
    expect(sentText).not.toContain('x'.repeat(201));
  });
});
