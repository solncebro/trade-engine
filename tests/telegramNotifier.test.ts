const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 1 });

// Mock ONLY createBot so the bot's telegram.sendMessage is observable; the sender, broadcaster and
// MarkdownV2 escaper stay real, exercising the centralized telegram-engine path end to end.
jest.mock('@solncebro/telegram-engine', () => {
  const actual = jest.requireActual('@solncebro/telegram-engine');

  return {
    ...actual,
    createBot: jest.fn(() => ({
      bot: { telegram: { sendMessage: mockSendMessage } },
      botName: 'test',
      launch: jest.fn(),
      stop: jest.fn(),
    })),
  };
});

import { TelegramNotifier } from '../src/services/telegramNotifier';

describe('TelegramNotifier', () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    mockSendMessage.mockResolvedValue({ message_id: 1 });
  });

  it('broadcasts a message to every chat in the list as escaped MarkdownV2', async () => {
    const notifier = new TelegramNotifier({
      botToken: 't',
      chatId: ['111', '222'],
    });

    await notifier.sendMessage('hello (world)');

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage.mock.calls.map(call => call[0])).toEqual([
      '111',
      '222',
    ]);
    expect(mockSendMessage).toHaveBeenCalledWith(
      '111',
      'hello \\(world\\)',
      expect.objectContaining({ parse_mode: 'MarkdownV2' })
    );
  });

  it('treats a bare string chatId as a single-chat list (back-compat)', async () => {
    const notifier = new TelegramNotifier({ botToken: 't', chatId: '999' });

    expect(notifier.getChatId()).toBe('999');
    expect(notifier.getChatIdList()).toEqual(['999']);

    await notifier.sendFormattedMessage('hi');

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      '999',
      'hi',
      expect.objectContaining({ parse_mode: 'MarkdownV2' })
    );
  });

  it('trims and drops empty chat ids', () => {
    const notifier = new TelegramNotifier({
      botToken: 't',
      chatId: [' 111 ', '', '  ', '222'],
    });

    expect(notifier.getChatIdList()).toEqual(['111', '222']);
    expect(notifier.getChatId()).toBe('111');
  });

  it('throws when no usable chat id is provided', () => {
    expect(
      () => new TelegramNotifier({ botToken: 't', chatId: [] })
    ).toThrow('at least one chat id');
    expect(
      () => new TelegramNotifier({ botToken: 't', chatId: '  ' })
    ).toThrow('at least one chat id');
  });

  it('isolates a failing chat and still attempts the others', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('boom'));

    const notifier = new TelegramNotifier({
      botToken: 't',
      chatId: ['111', '222'],
    });

    await expect(notifier.sendMessage('msg')).resolves.toBeUndefined();
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });
});
