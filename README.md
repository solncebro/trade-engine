# @solncebro/trade-engine

Universal trading engine library for Binance and Bybit with Telegram integration and Firebase support.

Built on top of [`@solncebro/exchange-engine`](https://github.com/solncebro/exchange-engine).

## Installation

```bash
yarn add @solncebro/trade-engine
```

## Quick Start

### Connect to an exchange

```typescript
import {
  ExchangeConnector,
  ExchangeNameEnum,
  PositionModeEnum,
} from '@solncebro/trade-engine';

const connector = new ExchangeConnector(
  ExchangeNameEnum.Bybit,
  {
    apiKey: process.env.API_KEY!,
    secret: process.env.API_SECRET!,
    isDemoMode: true,
  },
  undefined,
  PositionModeEnum.Hedge,
);

await connector.initialize();
```

Для futures-ордеров можно управлять авто-`positionSide` через 4-й аргумент конструктора `futuresPositionMode`: по умолчанию `PositionModeEnum.OneWay` (авто-`positionSide` не подставляется), в `PositionModeEnum.Hedge` — smart-inference как safety-net (открытие: `Buy → Long`, `Sell → Short`; закрытие при `reduceOnly=true`: `Sell → Long`, `Buy → Short`). **Идиоматический путь** — `connector.positionManager.*` с явным `direction`, который выводит все биржевые поля внутри библиотеки.

### Open / close positions via PositionManager (recommended)

```typescript
import { MarketTypeEnum, MarginModeEnum } from '@solncebro/trade-engine';

// Open futures long with explicit setup
const openResult = await connector.positionManager.openPositionLimit({
  symbol: 'BTCUSDT',
  marketType: MarketTypeEnum.Futures,
  direction: 'long',
  amount: 0.01,
  price: 50000,
  leverage: 5,
  marginMode: MarginModeEnum.Isolated,
});

// Close half at market
await connector.positionManager.closePositionMarket({
  symbol: 'BTCUSDT',
  marketType: MarketTypeEnum.Futures,
  direction: 'long',
  amount: 0.005,
});

// Place reduce-only stop loss (Bybit conditional Market or Binance STOP_MARKET inferred internally)
await connector.positionManager.placeStopLoss({
  symbol: 'BTCUSDT',
  marketType: MarketTypeEnum.Futures,
  direction: 'long',
  triggerPrice: 48000,
  amount: 0.005,
});

// Spot Market Buy with USDT amount (Bybit `marketUnit=quoteCoin` / Binance `quoteOrderQty`)
await connector.positionManager.spotMarketBuyByQuote({
  symbol: 'ETHUSDT',
  quoteAmount: 100,
});
```

`direction='short'` on `marketType=Spot` throws `Error: SHORT positions are not supported on spot. Use marketType=Futures.` synchronously.

### Resolve symbols and create orders

```typescript
import {
  ExchangeNameEnum,
  MarketTypeEnum,
  OrderCalculator,
  OrderSideEnum,
  OrderTypeEnum,
  isOrderSuccessful,
} from '@solncebro/trade-engine';

// Map symbols across exchanges (handles prefixed symbols like 1000FLOKIUSDT)
const connectorByName = new Map([[ExchangeNameEnum.Bybit, connector]]);
const symbolMapping = OrderCalculator.resolveSymbolsForExchanges(
  ['ETHUSDT'],
  connectorByName
);

// Calculate order attributes
const orderAttributes = OrderCalculator.createOrderAttributesForSymbol({
  isLong: true,
  exchangeConnectorByName: connectorByName,
  symbolMappingByExchange: symbolMapping,
  stopBuyAfterPercent: 30,
  allowedVolumeByExchange: new Map([[ExchangeNameEnum.Bybit, 100]]),
  leverage: 5,
});

// Execute order
for (const attr of orderAttributes) {
  if (attr.errorText) {
    console.warn(attr.errorText);
    continue;
  }

  const result = await connector.createOrder(attr.orderParams);

  if (isOrderSuccessful(result)) {
    console.log('Order placed:', result.orderId);
  } else {
    console.warn('Order failed:', result.errorText);
  }
}
```

### Direct client access

Access exchange clients directly for any operation — positions, balances, leverage, margin mode, etc.:

```typescript
import { MarginModeEnum } from '@solncebro/trade-engine';

// Futures
await connector.futures.setLeverage(5, 'BTCUSDT');
await connector.futures.setMarginMode(MarginModeEnum.Isolated, 'BTCUSDT');
const position = await connector.futures.fetchPosition('BTCUSDT');
const balances = await connector.futures.fetchBalances();

// Spot
const spotBalances = await connector.spot.fetchBalances();
```

### Spot fallback

If a symbol is not available on futures, the engine can automatically fall back to spot:

```typescript
const enriched = OrderCalculator.enrichWithSpotFallback({
  orderAttributesList: orderAttributes,
  exchangeConnectorByName: connectorByName,
  stopBuyAfterPercent: 30,
  allowedVolumeByExchange: new Map([[ExchangeNameEnum.Bybit, 100]]),
  leverage: 5,
});
```

### Take Profit / Stop Loss

```typescript
const tpParams = OrderCalculator.calculateCloseOrder(
  orderParams,
  10,   // +10% for take profit
  true  // isTakeProfit
);

const slParams = OrderCalculator.calculateCloseOrder(
  orderParams,
  -5,   // -5% for stop loss
  false // isTakeProfit
);
```

### Limit orders with price adjustment

```typescript
const limitParams = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
  orderParams,
  priceAdjustmentPercent: 40,   // +40% price adjustment
  orderVolumeUsdt: 100,
  leverage: 5,
});
```

### Mark price streaming

```typescript
connector.startWatchingMarkPrices();

const markPriceUpdate = connector.getMarkPrice('BTCUSDT');
// { symbol, markPrice, indexPrice?, timestamp }

connector.stopWatchingMarkPrices();
```

### Price limit bounds

```typescript
const bounds = OrderCalculator.calculatePriceLimitBounds({
  tradeSymbol,
  markPrice: 50000,
  indexPrice: 49980,
});
// { minPrice, maxPrice, minDeviationPercent, maxDeviationPercent, source } | null
```

## Exports

### Classes

| Class | Description |
|-------|------------|
| `ExchangeConnector` | Exchange connection, tickers, symbol resolution, low-level `createOrder`; optional `futuresPositionMode` for futures `positionSide` behavior. Lazy-init `connector.positionManager`. |
| `PositionManager` | High-level semantic API for spot/futures (`openPositionLimit/Market`, `closePositionLimit/Market`, `placeStopLoss/TakeProfit`, `cancelOrder/cancelBatchOrders`, `spotMarketBuyByQuote`, `setLeverage/setMarginMode`). Hides `positionSide`/`positionIdx`/`reduceOnly`/`closePosition`/`workingType`/`triggerDirection`/`triggerBy`/`orderFilter`/`marketUnit` from callers; takes business arguments (`symbol`, `marketType`, `direction`, `amount`, `price`/`triggerPrice`). Spot + `direction='short'` throws. |
| `OrderCalculator` | Static methods for order calculation, symbol mapping, leverage setup; `calculateCloseOrder` preserves `positionSide` from source `orderParams` |
| `OrderExecutor` | Base class for order execution with TP/SL and emergency exit (legacy path; new code uses `PositionManager`) |
| `TelegramNotifier` | Telegraf bot for sending notifications and registering commands |
| `TelegramCommandHandler<T>` | Command handler with typed settings (boolean/numeric) |
| `TelegramMessageListener` | MTProto client for listening to Telegram channel messages |
| `FirebaseServiceBase<T>` | Firestore CRUD with real-time subscription |
| `ConfigManager` | Environment variable validation |

### Enums (re-exported from `@solncebro/exchange-engine`)

| Enum | Values |
|------|--------|
| `ExchangeNameEnum` | `Binance`, `Bybit` |
| `OrderSideEnum` | `Buy`, `Sell` |
| `OrderTypeEnum` | `Market`, `Limit`, `StopMarket`, `StopLimit`, `TakeProfitMarket`, `TakeProfitLimit`, `Stop`, `TakeProfit`, `TrailingStop` |
| `MarginModeEnum` | `Isolated`, `Cross` |
| `PositionModeEnum` | `Hedge`, `OneWay` |
| `MarketTypeEnum` | `Futures`, `Spot` |
| `MarketUnitEnum` | `baseCoin`, `quoteCoin` (Bybit Spot Market amount unit) |
| `OrderFilterEnum` | `Order`, `tpslOrder`, `StopOrder` (Bybit Spot conditional/TPSL filter) |
| `TriggerByEnum` | `MarkPrice`, `LastPrice`, `IndexPrice` (Bybit Linear conditional trigger source) |
| `TimeInForceEnum` | `Gtc`, `Ioc`, `Fok`, `PostOnly` |
| `TradeSymbolTypeEnum` | `Spot`, `Swap`, `Future` |

### Types

| Type | Description |
|------|------------|
| `OrderParams` | Order parameters (symbol, side, amount, price, type, marketType) |
| `OrderAttributes` | Calculated order with exchange name and optional error |
| `OrderResult` | Execution result with orderId, responseData, optional errorCode and attemptCount |
| `CloseOrderResult` | TP/SL order result |
| `SignalExecutionDetails` | Full signal execution with TP/SL/emergency results and timings |
| `PriceLimitBoundsArgs` | Arguments for `calculatePriceLimitBounds` |
| `PriceLimitBounds` | Price limit calculation result (min/max price with deviation percentages) |
| `SymbolMappingByExchange` | `Map<ExchangeNameEnum, Map<string, string>>` |
| `ExchangeConnectorByName` | `Map<ExchangeNameEnum, ExchangeConnector>` |
| `ExchangeConfig` | `{ apiKey, secret, isDemoMode? }` |

### Utilities

| Function | Description |
|----------|------------|
| `isOrderSuccessful(result)` | Check if order has orderId |
| `isSpot(marketType)` | Check if market type is spot |
| `normalizeSymbol(symbol)` | Remove exchange suffixes (`:`, `/`, `.`, `-`) |
| `formatTimestamp(ts)` | Format timestamp to `HH:mm:ss.SSS` |
| `createLogger(args?)` | Create pino logger with optional BetterStack transport |

## Key Principles

- **Errors are not exceptions (for `createOrder`)**: `createOrder()` returns `errorText` in the result instead of throwing. Check via `isOrderSuccessful(result)`. Direct calls to `connector.spot` / `connector.futures` may throw and should be wrapped in `try/catch`.
- **Demo trading**: set `ExchangeConfig.isDemoMode = true`. No manual URL overrides.
- **Symbol prefixes**: `resolveSymbolWithPrefix()` automatically handles exchange-specific prefixes (e.g. `1000FLOKIUSDT` on Bybit).
- **Map collections**: `SymbolMappingByExchange` and `ExchangeConnectorByName` are `Map`, not plain objects.

## Requirements

- Node.js >= 18
- `@solncebro/exchange-engine` >= 0.13.0

## License

[MIT](LICENSE)
