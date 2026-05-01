# Система типов

Все типы в `src/types/`, реэкспортируются через `src/types/index.ts`.

## Реэкспорты из exchange-engine

Из `@solncebro/exchange-engine` (0.13.0+) реэкспортируются:
- **Constants**: `MARKET_TYPE_LIST`
- **Enums**: `ExchangeNameEnum`, `MarginModeEnum`, `MarketTypeEnum`, `MarketUnitEnum`, `OrderFilterEnum`, `OrderSideEnum`, `OrderTypeEnum`, `PositionModeEnum`, `PositionSideEnum`, `TimeInForceEnum`, `TradeSymbolTypeEnum`, `TriggerByEnum`, `WebSocketConnectionTypeEnum`, `WorkingTypeEnum`
- **Types**: `AccountBalances`, `Balance`, `BalanceByAsset`, `ClosedPnl`, `CreateOrderWebSocketArgs`, `ExchangeArgs`, `ExchangeClient`, `ExchangeConfig`, `ExchangeLogger`, `FeeRate`, `FetchAllKlinesOptions`, `FetchPageWithLimitArgs`, `FundingInfo`, `FundingRateHistory`, `Income`, `Kline`, `KlineHandler`, `KlineInterval`, `MarkPrice`, `MarkPriceUpdate`, `ModifyOrderArgs`, `OpenInterest`, `Order`, `OrderBook`, `OrderBookLevel`, `OrderUpdateEvent`, `OrderUpdateHandler`, `Position`, `PositionUpdateEvent`, `PositionUpdateHandler`, `PublicTrade`, `ResubscribeKlinesArgs`, `SubscribeKlinesArgs`, `Ticker`, `TickerBySymbol`, `TradeSymbol`, `TradeSymbolBySymbol`, `TradeSymbolFilter`, `UserDataStreamHandlerArgs`, `WebSocketConnectionInfo`
- **Classes**: `ExchangeError`

## Собственные классы trade-engine (3.4.0)

- **`PositionManager`** (`src/core/positionManager.ts`) — высокоуровневый семантический API; доступ через `ExchangeConnector.positionManager`.
- **Экспорт из entry** (`src/index.ts`) — типы из `positionManager.types.ts`: `Direction`, `StopOrderType`, `OpenPositionLimitArgs`, `OpenPositionMarketArgs`, `ClosePositionLimitArgs`, `ClosePositionMarketArgs`, `PlaceStopLossArgs`, `PlaceTakeProfitArgs`, `CancelOrderArgs`, `CancelBatchOrdersArgs`, `SpotMarketBuyByQuoteArgs`, `SetLeverageArgs`, `SetMarginModeArgs`.
- **Внутренние типы** того же файла (без реэкспорта из entry): `PlaceConditionalArgs`, `BuildOrderParamsInput`, `ApplyFuturesSetupArgs`.

## Основные типы

### Рынки и ордера (`orders.ts`)

```typescript
// MarketTypeEnum — реэкспортируется из @solncebro/exchange-engine

interface OrderParams {
  symbol: string;
  side: OrderSideEnum;       // Buy | Sell
  amount: number;
  price: number;
  type: OrderTypeEnum;       // Market | Limit | StopMarket | StopLimit | TakeProfitMarket | TakeProfitLimit | Stop | TakeProfit | TrailingStop
  marketType?: MarketTypeEnum;
  positionSide?: PositionSideEnum;  // Long | Short — явное управление сайдом позиции (только futures)
  triggerPrice?: number;     // для SL ордеров
  triggerDirection?: 1 | 2;  // 1 = рост, 2 = падение
  triggerBy?: TriggerByEnum;          // 3.4.0 — Bybit Linear: MarkPrice | LastPrice | IndexPrice
  workingType?: WorkingTypeEnum;       // 3.4.0 — Binance Futures: MarkPrice | ContractPrice
  reduceOnly?: boolean;                // 3.4.0 — top-level (читается приоритетом над params.reduceOnly)
  closeOnTrigger?: boolean;            // 3.4.0 — Bybit Linear conditional close
  closePosition?: boolean;             // 3.4.0 — Binance STOP_MARKET/TAKE_PROFIT_MARKET закрытие всей позиции
  orderFilter?: OrderFilterEnum;       // 3.4.0 — Bybit Spot: Order | tpslOrder | StopOrder
  marketUnit?: MarketUnitEnum;         // 3.4.0 — Bybit Spot Market: baseCoin | quoteCoin
  trailingDelta?: number;              // 3.4.0 — Binance Spot STOP_LOSS/TAKE_PROFIT trailing
  quoteOrderQty?: number;              // 3.4.0 — Binance/Bybit Spot Market Buy: USDT-сумма вместо qty
  clientOrderId?: string;              // 3.4.0 — клиентский id (orderLinkId на Bybit, newClientOrderId на Binance)
  params?: Record<string, unknown>; // доп. параметры биржи
}

interface EntityWithOrderId {
  orderId?: string;
}

interface EntityWithErrorText {
  errorText?: string;
  errorCode?: number | string; // код ошибки биржи (из ExchangeError.code)
}

interface OrderAttributes extends EntityWithErrorText {
  orderParams: OrderParams;
  exchangeName: ExchangeNameEnum;
  orderVolumeUsdt?: number; // расчётный объём в USDT для символа
}

interface OrderResult extends OrderAttributes, EntityWithOrderId {
  actualExchangeParams?: ExchangeOrderParams;
  responseData?: ExchangeResponseData;
  attemptCount?: number; // количество попыток создания ордера
}

interface CloseOrderResult extends EntityWithErrorText, EntityWithOrderId {
  price?: number;
}
```

### Тайминги

```typescript
interface OrderTiming {
  requestSentAt: number;
  responseReceivedAt: number;
}

interface OrderTimings {
  signalReceivedAt: number;
  entryOrder: OrderTiming;
  takeProfitOrder?: OrderTiming;
  stopLossOrder?: OrderTiming;
  emergencyExitOrder?: OrderTiming;
}

interface SignalExecutionDetails extends OrderResult {
  takeProfitOrderResult?: CloseOrderResult;
  stopLossOrderResult?: CloseOrderResult;
  emergencyExitOrderResult?: CloseOrderResult;
  timings?: OrderTimings;
}
```

### Маппинги

```typescript
type SymbolMappingByExchange = Map<ExchangeNameEnum, Map<string, string>>;
// Map<биржа, Map<оригинальный символ, резолвленный символ>>

type ExchangeConnectorByName = Map<ExchangeNameEnum, ExchangeConnector>;
```

### Конфигурация (реэкспорт из exchange-engine)

```typescript
// ExchangeConfig — определён в @solncebro/exchange-engine, реэкспортируется
interface ExchangeConfig {
  apiKey: string;
  secret: string;
  isDemoMode?: boolean;  // включить demo trading
  recvWindow?: number;
  httpsAgent?: unknown;
}
```

### Биржевые типы (`exchange.ts`)

```typescript
interface ExchangeOrderParams {
  symbol: string;
  side: string;
  amount?: number;
  qty?: string;
  type?: string;
  orderType?: string;
  price?: number | string;
  category?: string;
  timeInForce?: string;
  hedgeMode?: boolean;
  reduceOnly?: boolean;
  params?: Record<string, unknown>;
}

interface ExchangeResponseData {
  id?: string;
  orderId?: string;
  symbol?: string;
  side?: string;
  amount?: number;
  price?: number;
  average?: number;
  timestamp?: number;
  filled?: number;
  remaining?: number;
  cost?: number;
  fee?: { currency?: string; cost?: number };
}
```

### Telegram типы

```typescript
// telegram.ts
interface TelegramNotifierArgs { botToken: string; chatId: string }
interface TelegramMessageListenerArgs { apiId: number; apiHash: string; appSession: string }

// telegramCommandHandler.ts
interface SpecialCommandConfig { command: string; description: string; handler: CommandHandler }
interface BooleanSettingConfig<T> { key: T; label: string; enabledEmoji: string; disabledEmoji: string }
interface NumericSettingConfig<T> { key: T; label: string; suffix: string; emoji: string }
interface TelegramCommandHandlerConfig<T> {
  specialCommandList: SpecialCommandConfig[];
  numericSettingConfigList: NumericSettingConfig<keyof T>[];
  booleanSettingConfigList: BooleanSettingConfig<keyof T>[];
  settingsGetter: () => T;
  settingUpdater: (key: keyof T, value: unknown) => Promise<void>;
}
```

### User Data Stream типы (реэкспорт из exchange-engine)

```typescript
interface OrderUpdateEvent {
  symbol: string;
  orderId: string;
  clientOrderId: string;
  side: OrderSideEnum;
  status: string;
  price: number;
  avgPrice: number;
  amount: number;
  filledAmount: number;
  timestamp: number;
}

interface PositionUpdateEvent {
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealisedPnl: number;
  leverage: number;
  liquidationPrice: number;
  positionSide: string;
  timestamp: number;
}

type OrderUpdateHandler = (event: OrderUpdateEvent) => void;
type PositionUpdateHandler = (event: PositionUpdateEvent) => void;

interface UserDataStreamHandlerArgs {
  onOrderUpdate: OrderUpdateHandler;
  onPositionUpdate: PositionUpdateHandler;
}
// Используется в ExchangeClient.connectUserDataStream(handler)
```

### Ценовые лимиты (`priceLimit.ts`)

```typescript
interface PriceLimitBoundsArgs {
  tradeSymbol: TradeSymbol;
  markPrice: number;
  indexPrice?: number;
}

interface PriceLimitBounds {
  minPrice: number;
  maxPrice: number;
  minDeviationPercent: number;
  maxDeviationPercent: number;
  source: PriceLimitRisk['source']; // 'bybitRiskParameters' | 'binancePercentPriceBySide' | ...
}
```

Используется в `OrderCalculator.calculatePriceLimitBounds()`. Возвращает `null`, если у символа нет `priceLimitRisk` или `markPrice <= 0`, а также для `binancePercentPriceBySide` (не поддерживается в расчёте).

### Общие типы (`common.ts`)

```typescript
interface ExtensibleRecord {
  [key: string]: unknown;
}

interface Notifiable {
  onNotify: (message: string, isLogOnly?: boolean) => void | Promise<void>;
  onError: (customMessage: string, error: unknown) => void | Promise<void>;
}
```

### Исполнение ордеров (`orders.ts`)

```typescript
interface CreateOrderArgs {
  exchangeConnector: ExchangeConnector;
  orderParams: OrderParams;
}

interface CreateCloseOrderArgs {
  exchangeConnector: ExchangeConnector;
  orderParams: OrderParams;
  priceShiftPercent: number;
  isTakeProfit: boolean;
  isEmergencyExitPosition?: boolean;
}
```

### Маппинг символов (`orders.ts`)

```typescript
interface SignalRejectionArgs {
  message: string;
  logData: Record<string, unknown>;
}

interface SymbolMappingResult {
  exchangeName: string;
  originalSymbol: string;
  resolvedSymbol: string;
}
```

### Расчёт ордеров (`orders.ts`)

```typescript
interface CalculateAmountForMarketTypeArgs {
  price: number;
  allowedVolumeUsdt: number;
  uniqueSymbolCount: number;
  leverage: number;
  marketType: MarketTypeEnum;
}
```

### Firebase типы (`firebase.ts`)

```typescript
type FirebaseStrategySettingsValues = string[] | number | boolean;

interface SettingChange<V> {
  key: string;
  current: V;
  previous: V;
  isChanged: boolean;
}
```

## Проверка результатов

```typescript
// Проверка успешности ордера — НЕ исключения, а проверка orderId
isOrderSuccessful(result: EntityWithOrderId): boolean  // !!result.orderId
isSpot(marketType?: MarketTypeEnum): boolean               // marketType === Spot
```
