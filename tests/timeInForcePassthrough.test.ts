import { ExchangeNameEnum, MarketTypeEnum, PositionModeEnum, TimeInForceEnum } from '@solncebro/exchange-engine';

import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig, OrderSideEnum, OrderTypeEnum } from '../src/types';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

jest.mock('@solncebro/exchange-engine', () => {
  const actual = jest.requireActual('@solncebro/exchange-engine');
  const buildClient = () => ({
    amountToPrecision: (_s: string, a: number) => a,
    priceToPrecision: (_s: string, p: number) => p,
    createOrderWebSocket: jest.fn().mockResolvedValue({ id: 'oid', symbol: 'BTCUSDT' }),
    createBatchOrders: jest.fn().mockImplementation(async (argsList: unknown[]) =>
      argsList.map((_, index) => ({ isSuccess: true, order: { id: `b${index}`, symbol: 'BTCUSDT' }, errorText: null }))
    ),
  });

  return {
    ...actual,
    Exchange: jest.fn().mockImplementation(() => ({ futures: buildClient(), spot: buildClient(), close: jest.fn() })),
  };
});

function createConnector(): ExchangeConnector {
  return new ExchangeConnector(ExchangeNameEnum.Bybit, { apiKey: 'k', secret: 's' } as ExchangeConfig, undefined, PositionModeEnum.OneWay, { isEnabled: false }, null);
}

const LIMIT_ARGS = { symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'long' as const, amount: 1, price: 100 };

describe('time-in-force passthrough', () => {
  it('a limit order stays «good till cancel» by default', async () => {
    const result = await createConnector().positionManager.openPositionLimit(LIMIT_ARGS);

    expect(result.actualExchangeParams?.timeInForce).toBe(TimeInForceEnum.Gtc);
  });

  it('openPositionLimit / closePositionLimit forward PostOnly to the exchange', async () => {
    const connector = createConnector();
    const openResult = await connector.positionManager.openPositionLimit({ ...LIMIT_ARGS, timeInForce: TimeInForceEnum.PostOnly });
    const closeResult = await connector.positionManager.closePositionLimit({ ...LIMIT_ARGS, timeInForce: TimeInForceEnum.PostOnly });

    expect(openResult.actualExchangeParams?.timeInForce).toBe(TimeInForceEnum.PostOnly);
    expect(closeResult.actualExchangeParams?.timeInForce).toBe(TimeInForceEnum.PostOnly);
    expect(closeResult.actualExchangeParams?.reduceOnly).toBe(true);
  });

  it('batch limits forward it to every item', async () => {
    const connector = createConnector();
    const itemList = [
      { direction: 'long' as const, amount: 1, price: 100 },
      { direction: 'long' as const, amount: 1, price: 99 },
    ];

    await connector.positionManager.openPositionBatchLimit({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, itemList, timeInForce: TimeInForceEnum.PostOnly });
    await connector.positionManager.closePositionBatchLimit({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, itemList, timeInForce: TimeInForceEnum.Ioc });

    const sentList = (connector.futures.createBatchOrders as jest.Mock).mock.calls.map(call => call[0].map((args: { timeInForce: string }) => args.timeInForce));

    expect(sentList).toEqual([
      [TimeInForceEnum.PostOnly, TimeInForceEnum.PostOnly],
      [TimeInForceEnum.Ioc, TimeInForceEnum.Ioc],
    ]);
  });

  it('a market order is always «immediate or cancel», whatever was asked', async () => {
    const result = await createConnector().createOrder({ symbol: 'BTCUSDT', side: OrderSideEnum.Sell, amount: 1, price: 0, type: OrderTypeEnum.Market, marketType: MarketTypeEnum.Futures, timeInForce: TimeInForceEnum.PostOnly });

    expect(result.actualExchangeParams?.timeInForce).toBe(TimeInForceEnum.Ioc);
  });
});
