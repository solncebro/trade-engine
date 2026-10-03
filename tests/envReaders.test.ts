import {
  parseChatIdList,
  readBoolean,
  readEnum,
  readOptionalString,
  readPositiveNumber,
} from '../src/core/envReaders';

const NAME = 'TRADE_ENGINE_TEST_ENV_VALUE';

afterEach(() => {
  delete process.env[NAME];
});

describe('parseChatIdList', () => {
  it('parses a single chat id', () => {
    expect(parseChatIdList('123')).toEqual(['123']);
  });

  it('splits a comma-separated list and trims whitespace', () => {
    expect(parseChatIdList('123, -100456 ,789')).toEqual(['123', '-100456', '789']);
  });

  it('drops empty entries from stray commas', () => {
    expect(parseChatIdList('123,, ,456,')).toEqual(['123', '456']);
  });

  it('throws when no usable chat id remains, naming the variable', () => {
    expect(() => parseChatIdList('')).toThrow('TELEGRAM_ALLOWED_CHAT_IDS must contain at least one chat id');
    expect(() => parseChatIdList('  , , ', 'ALERT_CHAT_IDS')).toThrow('ALERT_CHAT_IDS must contain at least one chat id');
  });
});

describe('readPositiveNumber', () => {
  it('falls back when the variable is unset or blank', () => {
    expect(readPositiveNumber(NAME, 4)).toBe(4);
    process.env[NAME] = '   ';
    expect(readPositiveNumber(NAME, 4)).toBe(4);
  });

  it('reads a positive value, fractional included', () => {
    process.env[NAME] = '12';
    expect(readPositiveNumber(NAME, 4)).toBe(12);
    process.env[NAME] = '0.5';
    expect(readPositiveNumber(NAME, 4)).toBe(0.5);
  });

  // Silently substituting the default would run the bot on a number the operator never chose.
  it('throws on a malformed or non-positive value instead of defaulting', () => {
    process.env[NAME] = 'abc';
    expect(() => readPositiveNumber(NAME, 4)).toThrow('must be a positive number');
    process.env[NAME] = '0';
    expect(() => readPositiveNumber(NAME, 4)).toThrow('must be a positive number');
    process.env[NAME] = '-3';
    expect(() => readPositiveNumber(NAME, 4)).toThrow('must be a positive number');
  });
});

describe('readOptionalString', () => {
  it('returns null for unset or blank, the trimmed value otherwise', () => {
    expect(readOptionalString(NAME)).toBeNull();
    process.env[NAME] = '  ';
    expect(readOptionalString(NAME)).toBeNull();
    process.env[NAME] = '  https://example.supabase.co ';
    expect(readOptionalString(NAME)).toBe('https://example.supabase.co');
  });
});

describe('readEnum', () => {
  const MODE_LIST = ['feeder', 'embedded'] as const;

  it('falls back when unset', () => {
    expect(readEnum(NAME, MODE_LIST, 'feeder')).toBe('feeder');
  });

  it('returns an allowed value', () => {
    process.env[NAME] = ' embedded ';
    expect(readEnum(NAME, MODE_LIST, 'feeder')).toBe('embedded');
  });

  it('throws on a value outside the list, listing the allowed ones', () => {
    process.env[NAME] = 'Embedded';
    expect(() => readEnum(NAME, MODE_LIST, 'feeder')).toThrow('Must be one of: "feeder", "embedded"');
  });
});

describe('readBoolean', () => {
  it('falls back when unset', () => {
    expect(readBoolean(NAME, true)).toBe(true);
    expect(readBoolean(NAME, false)).toBe(false);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['0', false],
    ['No', false],
    ['off', false],
  ])('reads "%s" as %s', (rawValue, expected) => {
    process.env[NAME] = rawValue;
    expect(readBoolean(NAME, !expected)).toBe(expected);
  });

  it('throws on anything else instead of guessing', () => {
    process.env[NAME] = 'maybe';
    expect(() => readBoolean(NAME, false)).toThrow('must be a boolean');
  });
});
