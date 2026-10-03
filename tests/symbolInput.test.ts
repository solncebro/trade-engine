import { normalizeSymbol, parseRawSymbolInput } from '../src/utils/symbol.utils';

describe('parseRawSymbolInput', () => {
  it.each([
    ['$pepe', 'PEPEUSDT'],
    ['#BTC', 'BTCUSDT'],
    [' btc ', 'BTCUSDT'],
    ['BTC/USDT', 'BTCUSDT'],
    ['BTCUSDT.P', 'BTCUSDT'],
    ['PEPE/USDT:USDT', 'PEPEUSDT'],
    ['1000PEPE', '1000PEPEUSDT'],
    ['btcusdt', 'BTCUSDT'],
    ['ETH-USDT-SWAP', 'ETHUSDT'],
    ['BTC_USDT', 'BTCUSDT'],
    ['eth/usdc', 'ETHUSDC'],
    ['SOLUSDC', 'SOLUSDC'],
    ['#WIF-PERP', 'WIFUSDT'],
  ])('%s → %s', (raw, expected) => {
    expect(parseRawSymbolInput(raw)).toBe(expected);
  });

  it('input without letters or digits gives null', () => {
    expect(parseRawSymbolInput('   ')).toBeNull();
    expect(parseRawSymbolInput('$#')).toBeNull();
    expect(parseRawSymbolInput('/')).toBeNull();
  });

  it('leaves normalizeSymbol untouched (exchange names only lose separators)', () => {
    expect(normalizeSymbol('PEPE/USDT:USDT')).toBe('PEPEUSDT');
    expect(normalizeSymbol('btc')).toBe('btc');
  });
});
