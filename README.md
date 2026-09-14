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

После успешного `initialize()` коннектор сам обновляет списки инструментов обоих рынков **раз в сутки — в ближайшие 00:05 по всемирному времени, со случайным сдвигом 0–120 секунд** (чтобы несколько процессов на одном адресе не пришли к бирже одновременно). Без этого процесс, живущий неделями, не узнал бы ни об одной монете, вышедшей на биржу после его запуска. Расписание задаётся 8-м аргументом конструктора — `{ tradeSymbolsRefreshIntervalMs }` (умолчание сутки, `0` выключает); тот же круг по требованию — `connector.refreshAllTradeSymbols()`. Таймер не держит процесс живым и снимается в `disconnect()`.

Для futures-ордеров можно управлять авто-`positionSide` через 4-й аргумент конструктора `futuresPositionMode`: по умолчанию `PositionModeEnum.OneWay` (авто-`positionSide` не подставляется), в `PositionModeEnum.Hedge` — smart-inference как safety-net (открытие: `Buy → Long`, `Sell → Short`; закрытие при `reduceOnly=true`: `Sell → Long`, `Buy → Short`). **Идиоматический путь** — `connector.positionManager.*` с явным `direction`, который выводит все биржевые поля внутри библиотеки.

### Показ цен — только через `formatPrice` (обязательно)

```typescript
import { formatPrice, snapPriceToTick } from '@solncebro/trade-engine';

await connector.initialize(); // ставит тиковую сетку для formatPrice автоматически

formatPrice('PROMUSDT', 2.961579786096256); // "2.9616" — ровно то, что лежит в заявке
formatPrice('PROMUSDT', null);              // "—"
snapPriceToTick('PROMUSDT', 2.961579786096256); // 2.9616 (число, для базы/журнала)
```

Сырую цену показывать человеку нельзя нигде — ни в Telegram, ни в тревогах, ни в логах, ни в журнале: длинный хвост плавающей точки нечитаем и не совпадает с ценой, которая реально стоит на бирже. Без коннектора (бэктест, утилиты) источник сетки ставится вручную — `configurePriceTickSnapper(...)`.

То же правило — для **любого вычисленного числа**, не только цены. Результат сложения, умножения, деления (объём в USDT, маржа, количество контрактов, процент) в JavaScript несёт хвост плавающей точки (`0.1 + 0.2 → 0.30000000000000004`) и в сыром виде наружу не выходит:

```typescript
import { formatAmount, formatUsdAmount, formatPercent, roundPercent, roundUsdAmount, snapAmountToStep } from '@solncebro/trade-engine';

formatAmount('BTCUSDT', 0.1 + 0.2);       // "0.3" — на шаге количества символа (initialize() подключает и его)
formatUsdAmount(1250 - 333.3333333333);   // "916.67" — суммы USDT не точнее цента
formatPercent((0.443208 / 0.436 - 1) * 100); // "1.65"
snapAmountToStep('BTCUSDT', 0.1 + 0.2);   // 0.3 (число, для полей логов и журнала)
roundUsdAmount(916.666666);               // 916.67
roundPercent(1.653333);                   // 1.65
```

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

Symbol and volume math for a signal is **not** part of this library — the caller decides what to
buy and how much (the static `OrderCalculator` that used to do it was removed in 3.13.0 and moved
to the listing domain). What is left is name resolution and execution.

```typescript
import {
  MarketTypeEnum,
  OrderSideEnum,
  OrderTypeEnum,
  isOrderSuccessful,
} from '@solncebro/trade-engine';

// Exchange-specific name: the plain symbol first, then the 10 / 100 / 1000 / 10000 / 100000 /
// 1000000 prefixes against the ticker cache (1000FLOKIUSDT and the like). Nothing found — a
// warning is logged and the symbol comes back unchanged.
const symbol = connector.resolveSymbolWithPrefix('FLOKIUSDT', MarketTypeEnum.Futures);

// Low-level door to the exchange: amount and price are snapped to the symbol grid, timeInForce
// is filled in (Ioc for market, Gtc otherwise), triggerPrice goes out as stopPrice.
const result = await connector.createOrder({
  symbol,
  side: OrderSideEnum.Buy,
  amount: 1000,
  price: 0,
  type: OrderTypeEnum.Market,
  marketType: MarketTypeEnum.Futures,
});

if (isOrderSuccessful(result)) {
  console.log('Order placed:', result.orderId);
} else {
  console.warn('Order failed:', result.errorText, result.errorCode);
}
```

Prefer `connector.positionManager.*` (above) for anything business-shaped: it derives the order
side from `direction`, fills in the position side in hedge mode, withholds `reduceOnly` where the
exchange refuses it next to a position side, and routes every write through the rate-limit queue.

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

### Take Profit / Stop Loss

Use `connector.positionManager.placeStopLoss()` / `placeTakeProfit()` (see the PositionManager
section above): they take `direction`, `triggerPrice` and `amount`, and fill in the position side,
`reduceOnly` and the exchange-specific conditional order type themselves.

`OrderExecutor` is the older, inheritance-shaped path. Its protected `createCloseOrder()` builds
the closing order from the entry — opposite side, price shifted by a percent, a trigger price and
direction for the stop loss, `reduceOnly` on futures — and an emergency exit turns it into a plain
market order with no trigger:

```typescript
class MyExecutor extends OrderExecutor {
  async exit(exchangeConnector: ExchangeConnector, orderParams: OrderParams) {
    const takeProfit = await this.createCloseOrder({
      exchangeConnector,
      orderParams,
      priceShiftPercent: 10,   // +10% for take profit
      isTakeProfit: true,
    });

    const stopLoss = await this.createCloseOrder({
      exchangeConnector,
      orderParams,
      priceShiftPercent: -5,   // -5% for stop loss
      isTakeProfit: false,
    });

    return { takeProfit, stopLoss };
  }
}
```

> Removed in 3.13.0 together with the `OrderCalculator` class: the spot fallback ("no such symbol
> on futures — trade it on spot"), the limit price adjustment by a percent, and the price-limit
> bounds calculation. The market is chosen by the caller through `marketType`; only the
> `PriceLimitBoundsArgs` / `PriceLimitBounds` types survived, so consumers computing the bounds
> themselves keep one shape.

### Mark price streaming

```typescript
connector.startWatchingMarkPrices();

const markPriceUpdate = connector.getMarkPrice('BTCUSDT');
// { symbol, markPrice, indexPrice?, timestamp }

connector.stopWatchingMarkPrices();
```

### Order book (live depth) — the only door to depth

```typescript
import { MarketTypeEnum, sliceAskVolumeWithinBand } from '@solncebro/trade-engine';

// Reference-counted: the stream topic opens on the first subscribe of a symbol
// and closes on the last unsubscribe. Depth is fixed per exchange (Binance 20, Bybit 50).
connector.subscribeOrderBook('BTCUSDT', MarketTypeEnum.Futures);

// Synchronous read of the merged book: null until the first snapshot lands
// (or while a broken delta sequence waits for a fresh one).
const book = connector.getOrderBook('BTCUSDT', MarketTypeEnum.Futures);

if (book !== null) {
  // How much can be bought without paying more than 0.5% above the reference price.
  const slice = sliceAskVolumeWithinBand({
    askList: book.askList,
    referencePrice: 100,
    bandPercent: 0.5,
    remainingQty: 1_000,
  });
  // slice.qty, slice.boundaryPrice, slice.bestAskPrice, slice.isBeyondBand
}

// One-shot REST read — the fallback when the live book is not there in time.
const snapshot = await connector.fetchOrderBook('BTCUSDT', MarketTypeEnum.Futures, 20);

connector.unsubscribeOrderBook('BTCUSDT', MarketTypeEnum.Futures);
```

Never subscribe through `connector.getClient(...).subscribeOrderbook` — that is the raw client of the lower library; the merge of snapshots and deltas, the sequence check and the resubscribe live in `OrderBookTracker` behind the connector.

### Price limit bounds

Only the shape is shipped — `PriceLimitBoundsArgs` (`tradeSymbol`, `markPrice`, `indexPrice?`) and
`PriceLimitBounds` (`minPrice`, `maxPrice`, `minDeviationPercent`, `maxDeviationPercent`,
`source`). The calculation itself left with `OrderCalculator` in 3.13.0; the consumer computes the
bounds and keeps the shared shape. Note there is no premium addend in the args: the official Bybit
formula is `Min(Mark × (1+Y), Max(Index, Mark × (1+X)))`, and the home-grown `premiumAvg` term
inflated the band exactly on pinned pumps.

## Exports

### Classes

| Class | Description |
|-------|------------|
| `ExchangeConnector` | Exchange connection, tickers, symbol resolution, low-level `createOrder`; optional `futuresPositionMode` for futures `positionSide` behavior. Lazy-init `connector.positionManager`. |
| `PositionManager` | High-level semantic API for spot/futures (`openPositionLimit/Market`, `closePositionLimit/Market`, `placeStopLoss/TakeProfit`, `cancelOrder/cancelBatchOrders`, `spotMarketBuyByQuote`, `setLeverage/setMarginMode`). Hides `positionSide`/`positionIdx`/`reduceOnly`/`closePosition`/`workingType`/`triggerDirection`/`triggerBy`/`orderFilter`/`marketUnit` from callers; takes business arguments (`symbol`, `marketType`, `direction`, `amount`, `price`/`triggerPrice`). Spot + `direction='short'` throws. |
| `OrderExecutor` | Base class for order execution with TP/SL and emergency exit (legacy path; new code uses `PositionManager`). Builds the closing order itself — opposite side, price shifted by a percent, trigger for the stop loss, `reduceOnly` on futures, `positionSide` carried over from the entry |
| `TelegramNotifier` | Telegraf bot for sending notifications and registering commands |
| `TelegramCommandHandler<T>` | Command handler with typed settings (boolean/numeric) |
| `TelegramMessageListener` | MTProto client for listening to Telegram channel messages |
| `FirebaseServiceBase<T>` | Firestore CRUD with real-time subscription |
| `ConfigManager` | Environment variable validation |
| `OrderBookTracker` | Live merged order book per subscribed symbol (Binance partial-depth slices, Bybit snapshot + deltas, sequence-gap resubscribe); used by `ExchangeConnector.subscribeOrderBook/getOrderBook` |
| `StreamSubscriptionWatchdog` | Stream-type-agnostic subscription health watchdog; behaviour per stream comes from a `StreamWatchdogStrategy` (`OrderbookWatchdogStrategy`, `PublicTradeWatchdogStrategy`, `MarkPriceWatchdogStrategy`, `KlineWatchdogStrategy`) |
| `KlineSubscriptionWatchdog` | Thin kline-shaped shim over `StreamSubscriptionWatchdog` + `KlineWatchdogStrategy` (same public surface as before) |

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
| `PriceLimitBoundsArgs` | Shared argument shape for a consumer-side price-limit calculation (no premium addend by design) |
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
| `sliceAskVolumeWithinBand(args)` | Ask liquidity that fits within a price band above a reference price (pure) |
| `resolveOrderBookStreamDepth(exchangeName)` | Stream depth the order-book tracker subscribes at (Binance 20, Bybit 50) |
| `sleep(ms)` | Promise-wrapped `setTimeout` — the one pause primitive for the library and its consumers |
| `withTimeout(promise, ms, message)` | Race a promise against a timer |
| `withRetryOn429(args)` / `withResultRetry(args)` | Retry wrappers (exponential backoff on 429/5xx; result-based retry). `withReadRetry` was removed in 3.22.0 — it was the same function under a second name |

## Migration notes

Every removal or rename ships with a "what to do" row in `CHANGELOG.md` → `### Migration (для потребителей)`. The 3.22.0 rows in short: `withReadRetry` → `withRetryOn429`; `isPriceTickSnapperConfigured` → removed; a local `sleep`/`withTimeout` in an app → import from this package; order-book access through the raw client → `connector.subscribeOrderBook/getOrderBook/unsubscribeOrderBook`; `KlineSubscriptionWatchdog` → unchanged surface; `KlineSubscription{LastEntry,RecoveryState,OverdueEntry}` → `Stream{LastEntry,RecoveryState,OverdueEntry}`.

## Key Principles

- **Errors are not exceptions (for `createOrder`)**: `createOrder()` returns `errorText` in the result instead of throwing. Check via `isOrderSuccessful(result)`. Direct calls to `connector.spot` / `connector.futures` may throw and should be wrapped in `try/catch`.
- **Demo trading**: set `ExchangeConfig.isDemoMode = true`. No manual URL overrides.
- **Symbol prefixes**: `resolveSymbolWithPrefix()` automatically handles exchange-specific prefixes (e.g. `1000FLOKIUSDT` on Bybit).
- **Map collections**: `SymbolMappingByExchange` and `ExchangeConnectorByName` are `Map`, not plain objects.

## Requirements

- Node.js >= 22
- `@solncebro/exchange-engine` >= 0.13.0

## License

[MIT](LICENSE)
