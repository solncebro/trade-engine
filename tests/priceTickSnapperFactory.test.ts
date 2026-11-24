import { Exchange, ExchangeNameEnum, TradeSymbolTypeEnum } from '@solncebro/exchange-engine';
import type { ExchangeLogger, StepRounding, TradeSymbol } from '@solncebro/exchange-engine';

import {
  configurePriceTickSizeReader,
  configurePriceTickSnapper,
  createPriceTickSnapper,
  formatPrice,
  readPriceTickSize,
  snapPriceToTick,
} from '../src/utils/priceFormat';

const TICK_LIST = ['0.1', '0.01', '0.0005', '0.00001', '1'];
const ROUNDING_LIST: StepRounding[] = ['nearest', 'up', 'down'];
const SILENT_LOGGER: ExchangeLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} };

function buildTradeSymbol(symbol: string, tickSize: string): TradeSymbol {
  return {
    symbol,
    baseAsset: symbol,
    quoteAsset: 'USDT',
    settle: 'USDT',
    isActive: true,
    type: TradeSymbolTypeEnum.Future,
    isLinear: true,
    contractSize: 1,
    contractType: 'PERPETUAL',
    isTradifi: false,
    filter: { tickSize, stepSize: '0.001', minQty: '0.001', maxQty: '1000', minNotional: '5' },
  };
}

function buildPriceList(tick: number): number[] {
  return [
    tick * 12345,
    tick * 12345 + tick * 0.3,
    tick * 12345 + tick * 0.5,
    tick * 12345 + tick * 0.7,
    tick * 12345 + tick * 1e-12,
    0.1 + 0.2,
    2.96151,
    1.1 * 3,
    0.3 * 3,
  ];
}

// The real exchange client: its `priceToPrecision` is exactly what the connector's snapper calls.
const client = new Exchange(ExchangeNameEnum.Binance, { config: { apiKey: 'k', secret: 's' }, logger: SILENT_LOGGER }).futures;

afterEach(() => {
  configurePriceTickSnapper(null);
});

describe('createPriceTickSnapper', () => {
  it.each(TICK_LIST)('matches the exchange client priceToPrecision for tick %s, every rounding and price', (tick) => {
    client.tradeSymbols.set('XUSDT', buildTradeSymbol('XUSDT', tick));
    const snapper = createPriceTickSnapper((symbol) => (symbol === 'XUSDT' ? parseFloat(tick) : null));

    for (const rounding of ROUNDING_LIST) {
      for (const price of buildPriceList(parseFloat(tick))) {
        expect(snapper('XUSDT', price, rounding)).toBe(client.priceToPrecision('XUSDT', price, rounding));
      }
    }
  });

  it('returns the price unchanged for a symbol without a tick, like the connector snapper for an unknown symbol', () => {
    const snapper = createPriceTickSnapper(() => null);

    for (const rounding of ROUNDING_LIST) {
      expect(snapper('NOPEUSDT', 2.961579786096256, rounding)).toBe(2.961579786096256);
    }

    expect(createPriceTickSnapper(() => 0)('XUSDT', 1.23456789, 'nearest')).toBe(1.23456789);
  });

  it.each(TICK_LIST)('formatPrice under the factory snapper equals formatPrice under the client snapper, tick %s', (tick) => {
    client.tradeSymbols.set('XUSDT', buildTradeSymbol('XUSDT', tick));
    const tickReader = (symbol: string): number | null => (symbol === 'XUSDT' ? parseFloat(tick) : null);
    const priceList = buildPriceList(parseFloat(tick));

    configurePriceTickSnapper((symbol, price, rounding) => client.priceToPrecision(symbol, price, rounding));
    const expectedList = priceList.map((price) => formatPrice('XUSDT', price));
    const expectedUpList = priceList.map((price) => snapPriceToTick('XUSDT', price, 'up'));

    configurePriceTickSnapper(createPriceTickSnapper(tickReader));
    configurePriceTickSizeReader(tickReader);

    expect(readPriceTickSize('XUSDT')).toBe(parseFloat(tick));
    expect(priceList.map((price) => formatPrice('XUSDT', price))).toEqual(expectedList);
    expect(priceList.map((price) => snapPriceToTick('XUSDT', price, 'up'))).toEqual(expectedUpList);
  });

  it('a snapper rebuilt from readPriceTickSize values reproduces the installed grid', () => {
    client.tradeSymbols.set('XUSDT', buildTradeSymbol('XUSDT', '0.0005'));
    configurePriceTickSnapper((symbol, price, rounding) => client.priceToPrecision(symbol, price, rounding));
    configurePriceTickSizeReader((symbol) => (client.tradeSymbols.has(symbol) ? parseFloat(client.tradeSymbols.get(symbol)?.filter.tickSize ?? '') : null));

    const rebuilt = createPriceTickSnapper(readPriceTickSize);

    for (const rounding of ROUNDING_LIST) {
      for (const price of buildPriceList(0.0005)) {
        expect(rebuilt('XUSDT', price, rounding)).toBe(snapPriceToTick('XUSDT', price, rounding));
      }
    }
  });
});
