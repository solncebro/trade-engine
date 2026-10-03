import { describeError, describeExchangeRefusal } from '../src/utils/errorFormatter.utils';

describe('describeError', () => {
  it('gives the message of an Error and its toString when the message is empty', () => {
    expect(describeError(new Error('fetch failed'))).toBe('fetch failed');
    expect(describeError(new TypeError(''))).toBe('TypeError');
  });

  it('reads a message from a plain object (an exchange refusal), else stringifies', () => {
    expect(describeError({ message: 'Bybit API error 110090: order refused', code: 110090 })).toBe('Bybit API error 110090: order refused');
    expect(describeError('socket hang up')).toBe('socket hang up');
    expect(describeError(429)).toBe('429');
    expect(describeError(null)).toBe('Unknown error');
    expect(describeError(undefined)).toBe('Unknown error');
  });

  it('describeExchangeRefusal reads the same way', () => {
    const error = new Error('Failed to create order');

    expect(describeExchangeRefusal(error)).toBe(describeError(error));
  });
});
