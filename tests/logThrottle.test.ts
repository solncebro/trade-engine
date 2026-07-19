import { LogThrottle } from '../src/core/logThrottle';

describe('LogThrottle', () => {
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('shouldLog() returns true on the first call for a key', () => {
    const throttle = new LogThrottle();

    expect(throttle.shouldLog('key', 60_000)).toBe(true);
  });

  test('shouldLog() suppresses repeats within the window', () => {
    const throttle = new LogThrottle();

    expect(throttle.shouldLog('key', 60_000)).toBe(true);
    nowMs += 59_999;
    expect(throttle.shouldLog('key', 60_000)).toBe(false);
  });

  test('shouldLog() allows again once the window has elapsed', () => {
    const throttle = new LogThrottle();

    expect(throttle.shouldLog('key', 60_000)).toBe(true);
    nowMs += 60_000;
    expect(throttle.shouldLog('key', 60_000)).toBe(true);
  });

  test('shouldLog() isolates different keys', () => {
    const throttle = new LogThrottle();

    expect(throttle.shouldLog('a', 60_000)).toBe(true);
    expect(throttle.shouldLog('b', 60_000)).toBe(true);
    expect(throttle.shouldLog('a', 60_000)).toBe(false);
  });

  test('takeDroppedCount() returns the suppressed count and then resets it', () => {
    const throttle = new LogThrottle();

    throttle.shouldLog('key', 60_000);
    throttle.shouldLog('key', 60_000);
    throttle.shouldLog('key', 60_000);

    expect(throttle.takeDroppedCount('key')).toBe(2);
    expect(throttle.takeDroppedCount('key')).toBe(0);
  });

  test('throttled() logs the first call and suppresses repeats within the window', () => {
    const throttle = new LogThrottle();
    const info = jest.fn();
    const fakeLogger = { info, warn: jest.fn(), error: jest.fn() };

    throttle.throttled({ logger: fakeLogger, level: 'info', key: 'key', windowMs: 60_000, payload: { a: 1 }, message: 'hello' });
    nowMs += 10_000;
    throttle.throttled({ logger: fakeLogger, level: 'info', key: 'key', windowMs: 60_000, message: 'hello' });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith({ a: 1 }, 'hello');
  });

  test('throttled() appends the suppressed count on the next allowed emission', () => {
    const throttle = new LogThrottle();
    const warn = jest.fn();
    const fakeLogger = { info: jest.fn(), warn, error: jest.fn() };

    throttle.throttled({ logger: fakeLogger, level: 'warn', key: 'key', windowMs: 60_000, message: 'paused' });
    nowMs += 1_000;
    throttle.throttled({ logger: fakeLogger, level: 'warn', key: 'key', windowMs: 60_000, message: 'paused' });
    nowMs += 1_000;
    throttle.throttled({ logger: fakeLogger, level: 'warn', key: 'key', windowMs: 60_000, message: 'paused' });
    nowMs += 60_000;
    throttle.throttled({ logger: fakeLogger, level: 'warn', key: 'key', windowMs: 60_000, message: 'paused' });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith({}, 'paused (+2 similar suppressed in last 60s)');
  });
});
