// Characterization of TelegramCommandHandler: command names, usage replies, argument parsing and
// success/error texts. Written against the pre-migration implementation and kept green after the
// parsing moved to telegram-engine (parseYesNoArgument, buildCommandNameFromKey, validators).

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logger } from '../src/core/logger';
import { TelegramCommandHandler } from '../src/services/telegramCommandHandler';
import type { TelegramNotifier } from '../src/services/telegramNotifier';
import type {
  SpecialCommandConfig,
  TelegramCommandHandlerConfig,
} from '../src/types/telegramCommandHandler';
import { getCommandFromKey } from '../src/utils/telegramCommand.utils';

interface Settings {
  isTradingEnabled: boolean;
  maxOrderUsd: number;
}

interface FakeContext {
  reply: jest.Mock;
  message?: { text: string };
}

const createContext = (text: string): FakeContext => ({
  reply: jest.fn().mockResolvedValue(undefined),
  message: { text },
});

const setup = (settingUpdater = jest.fn().mockResolvedValue(undefined)) => {
  const registeredList: SpecialCommandConfig[] = [];
  const telegramNotifier = {
    registerCommand: (config: SpecialCommandConfig) => registeredList.push(config),
  } as unknown as TelegramNotifier;
  const specialHandler = jest.fn().mockResolvedValue(undefined);
  const config: TelegramCommandHandlerConfig<Settings> = {
    specialCommandList: [{ command: 'status', description: 'Status', handler: specialHandler }],
    booleanSettingConfigList: [
      { key: 'isTradingEnabled', label: 'Trading', enabledEmoji: '🟢', disabledEmoji: '🔴' },
    ],
    numericSettingConfigList: [{ key: 'maxOrderUsd', label: 'Max order', suffix: '$', emoji: '💵' }],
    settingsGetter: () => ({ isTradingEnabled: true, maxOrderUsd: 10 }),
    settingUpdater,
  };

  new TelegramCommandHandler<Settings>({ telegramNotifier, config });

  const findHandler = (command: string) => {
    const found = registeredList.find(item => item.command === command);

    if (!found) {
      throw new Error(`command ${command} not registered`);
    }

    return found;
  };

  return { registeredList, findHandler, settingUpdater, specialHandler };
};

describe('TelegramCommandHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers special commands first, then boolean, then numeric settings', () => {
    const { registeredList } = setup();

    expect(registeredList.map(item => [item.command, item.description])).toEqual([
      ['status', 'Status'],
      ['is_trading_enabled', 'Toggle Trading'],
      ['max_order_usd', 'Set Max order'],
    ]);
  });

  it.each([
    ['yes', true],
    ['TRUE', true],
    ['no', false],
    ['False', false],
  ])('boolean command accepts "%s"', async (argument, expected) => {
    const { findHandler, settingUpdater } = setup();
    const context = createContext(`/is_trading_enabled ${argument}`);

    await findHandler('is_trading_enabled').handler(context as never);

    expect(settingUpdater).toHaveBeenCalledWith('isTradingEnabled', expected);
    expect(context.reply).toHaveBeenCalledWith(
      expected ? '🟢 Trading enabled' : '🔴 Trading disabled'
    );
  });

  it.each(['/is_trading_enabled', '/is_trading_enabled maybe', '/is_trading_enabled  yes'])(
    'boolean command replies with usage for "%s"',
    async text => {
      const { findHandler, settingUpdater } = setup();
      const context = createContext(text);

      await findHandler('is_trading_enabled').handler(context as never);

      expect(settingUpdater).not.toHaveBeenCalled();
      expect(context.reply).toHaveBeenCalledWith('❌ Usage: /is_trading_enabled yes/no');
    }
  );

  it('numeric command stores a positive number', async () => {
    const { findHandler, settingUpdater } = setup();
    const context = createContext('/max_order_usd 12.5');

    await findHandler('max_order_usd').handler(context as never);

    expect(settingUpdater).toHaveBeenCalledWith('maxOrderUsd', 12.5);
    expect(context.reply).toHaveBeenCalledWith('💵 Max order set to 12.5');
  });

  it.each(['/max_order_usd', '/max_order_usd abc', '/max_order_usd 0', '/max_order_usd -3'])(
    'numeric command replies with usage for "%s"',
    async text => {
      const { findHandler, settingUpdater } = setup();
      const context = createContext(text);

      await findHandler('max_order_usd').handler(context as never);

      expect(settingUpdater).not.toHaveBeenCalled();
      expect(context.reply).toHaveBeenCalledWith('❌ Usage: /max_order_usd <value>');
    }
  );

  it('numeric command keeps parseFloat semantics ("7abc" → 7)', async () => {
    const { findHandler, settingUpdater } = setup();

    await findHandler('max_order_usd').handler(createContext('/max_order_usd 7abc') as never);

    expect(settingUpdater).toHaveBeenCalledWith('maxOrderUsd', 7);
  });

  it('a message without text is treated as a missing argument', async () => {
    const { findHandler } = setup();
    const context: FakeContext = { reply: jest.fn().mockResolvedValue(undefined) };

    await findHandler('max_order_usd').handler(context as never);

    expect(context.reply).toHaveBeenCalledWith('❌ Usage: /max_order_usd <value>');
  });

  it('a failed update replies "❌ Failed to update <key>" and logs', async () => {
    const failure = new Error('firestore down');
    const { findHandler } = setup(jest.fn().mockRejectedValue(failure));
    const context = createContext('/max_order_usd 5');

    await findHandler('max_order_usd').handler(context as never);

    expect(context.reply).toHaveBeenCalledWith('❌ Failed to update maxOrderUsd');
    expect(logger.error).toHaveBeenCalledWith({ error: failure }, 'Failed to update maxOrderUsd');
  });
});

describe('getCommandFromKey', () => {
  it.each([
    ['maxOrderUsd', 'max_order_usd'],
    ['isTradingEnabled', 'is_trading_enabled'],
    ['plain', 'plain'],
    ['ABC', '_a_b_c'],
  ])('%s → %s', (key, expected) => {
    expect(getCommandFromKey(key)).toBe(expected);
  });
});
