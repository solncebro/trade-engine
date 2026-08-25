# Система типов

Все типы в `src/types/`, реэкспортируются через `src/types/index.ts`.

## Реэкспорты из exchange-engine (3.19.0 — сквозной проброс типов)

Из `@solncebro/exchange-engine` (`>=0.22.0 <1.0.0`, из реестра npm — диапазон с 3.21.0) реэкспортируются:

- **Значения** (enum'ы, константы, функции, классы) — поимённым списком в `src/types/index.ts` и `src/index.ts`/`src/exchange.ts`: `MARKET_TYPE_LIST`, `ExchangeNameEnum`, `MarginModeEnum`, `MarketTypeEnum`, `MarketUnitEnum`, `OrderFilterEnum`, `OrderSideEnum`, `OrderTypeEnum`, `PositionModeEnum`, `PositionSideEnum`, `TimeInForceEnum`, `TradeSymbolTypeEnum`, `TriggerByEnum`, `WebSocketConnectionTypeEnum`, `WorkingTypeEnum`, `ExchangeError`, `formatWebSocketConnectionsReport`, `parseBybitOrderbookRawFrame`.
- **Типы — сквозняком, без поимённого перечня**: `src/types/index.ts` (и, через `export * from './types'`, оба входа пакета — `.` и `./exchange`) делают `export type * from '@solncebro/exchange-engine'`. Любой тип нижней библиотеки виден потребителю автоматически, включая появившиеся уже после этой правки — заводить отдельный реэкспорт под новый тип не нужно.
- **`Exchange` (фабрика) реэкспортируется ТОЛЬКО как тип** — `export type *` значения не пробрасывает, поэтому создать инстанс биржи в обход `ExchangeConnector` нельзя; принцип единой двери сохраняется. `formatWebSocketConnectionsReport`, в отличие от `Exchange`, реэкспортируется как обычное значение — потребителю можно его вызывать.

**Почему сквозняком, а не перечнем.** До 3.19.0 типы шли поимённым списком — дыру (забытый новый тип) латали новой публикацией пакета: восемь выпусков за пять месяцев, включая `TriggerByEnum`, реэкспортированный дважды уже после боевого инцидента с реальными деньгами. Сторож-тест `tests/exchangeEngineReexport.test.ts` проверяет и то, что каждое ЗНАЧЕНИЕ нижней библиотеки выходит из обоих входов пакета, и то, что поимённый перечень типов не возвращается (`export type { … } from '@solncebro/exchange-engine'` запрещён grep-проверкой по исходникам).

## Собственные классы trade-engine (3.4.0–3.5.0)

- **`PositionManager`** (`src/core/positionManager.ts`) — высокоуровневый семантический API; доступ через `ExchangeConnector.positionManager`.
- **`RateLimitedRequestQueue`** (`src/core/RateLimitedRequestQueue.ts`, 3.5.0) — sliding-window очередь с RPS-лимитом.
- **`KlineSubscriptionWatchdog`** (`src/services/klineSubscriptionWatchdog.ts`, 3.5.0) — мониторинг и автовосстановление kline-подписок.
- **`withRetryOn429`** / **`withReadRetry`** (`src/core/withRetryOn429.ts`, 3.5.0) — функциональные retry-обёртки.
- **`PremiumIndexCalculator`** (`src/services/premiumIndexCalculator.ts`) — per-symbol EMA «премии» (`midPrice − markPrice`, окно 30s) для подачи `premiumAvg` в `OrderCalculator.calculatePriceLimitBounds`; не auto-wired.
- **`TrendCalculator`** (`src/core/trendCalculator.ts`, 3.14.0) — статический расчёт тренда по структуре рынка: `computePivotList` (вершины/впадины), `assessTrend` (направление, слом, сила 0–100). → [подробнее](trend.md)
- **`TrendMonitor`** (`src/core/TrendMonitor.ts`, 3.14.0) — живой наблюдатель тренда поверх `MarketDataSource`; событие `trendChanged`, сводка по интервалам. Типы `trendCalculator.types.ts` (`TrendDirection`, `TrendCalculatorConfig`, `TrendPivot`, `TrendStrengthComponents`, `TrendAssessment`, `TrendAssessmentResult`, `ComputePivotListArgs`, `AssessTrendArgs`) и `TrendMonitor.types.ts` (`TrendMonitorArgs`, `TrendChangedEvent`, `TrendChangedListener`, `TrendSummary`) + `FormatTrendSummaryMessageArgs` реэкспортируются из entry. → [подробнее](trend.md)
- **Экспорт из entry** (`src/index.ts`) — типы из `positionManager.types.ts`: `Direction`, `StopOrderType`, `OpenPositionLimitArgs`, `OpenPositionMarketArgs`, `OpenPositionBatchLimitArgs`, `OpenPositionBatchLimitItem`, `OpenPositionBatchLimitResult`, `ClosePositionLimitArgs`, `ClosePositionMarketArgs`, `ClosePositionBatchLimitArgs`, `ClosePositionBatchLimitItem`, `ClosePositionBatchLimitResult`, `PositionBatchLimitItemResult`, `PlaceStopLossArgs`, `PlaceTakeProfitArgs`, `CancelOrderArgs`, `CancelBatchOrdersArgs`, `CancelAllOrdersArgs`, `PositionManagerModifyOrderArgs`, `PositionManagerModifyBatchOrdersArgs`, `PositionManagerModifyBatchOrderItem`, `ReadPositionStateArgs`, `ReadAllPositionsArgs`, `PositionStateResult`, `PositionAbsenceReason`, `PositionAmbiguityReason`, `SpotMarketBuyByQuoteArgs`, `SetLeverageArgs`, `SetMarginModeArgs`.
- **Внутренние типы** `positionManager.types.ts` (без реэкспорта из entry): `PlaceConditionalArgs`, `BuildOrderParamsInput`, `ApplyFuturesSetupArgs`.
- **Внутренние типы 3.5.0** для reliability-инфраструктуры: `KlineSubscriptionWatchdogArgs`, `KlineSubscriptionWatchdogConfig`, `KlineSubscriptionWatchdogDiagnostic`, `KlineSubscriptionLastEntry`, `KlineSubscriptionOverdueEntry`, `KlineSubscriptionRecoveryState`, `RateLimitedRequestQueueArgs`, `WithReadRetryArgs`, `WithRetryOn429Args`, `RateLimitConfig` (из `exchangeConnector.ts`).

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
  /** Скользящий стоп: отступ в ПРОЦЕНТАХ. Собственные единицы бирж прячет слой связи. */
  callbackRate?: number;                // 3.16.0 — заменил trailingDelta, работает на любом рынке
  /** Скользящий стоп: цена, с которой он начинает вести за ценой. */
  activationPrice?: number;             // 3.16.0
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
interface TelegramNotifierArgs { botToken: string; chatId: string | string[] }  // string[] — рассылка во все чаты
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

interface BalanceUpdateEvent {
  balanceList: BalanceUpdateItem[];
  timestamp: number;
}

interface BalanceUpdateItem {
  asset: string;
  free: number;
  locked: number;
}

type BalanceUpdateHandler = (event: BalanceUpdateEvent) => void;

interface UserDataStreamHandlerArgs {
  onOrderUpdate: OrderUpdateHandler;
  onPositionUpdate: PositionUpdateHandler;
  onBalanceUpdate?: BalanceUpdateHandler; // Binance Spot WS API, событие outboundAccountPosition (exchange-engine d93c52a)
}
// Используется в ExchangeClient.connectUserDataStream(handler)
// Binance Spot user-data теперь идёт через WebSocket API (класс BinanceSpotUserDataStream);
// listenKey REST удалён биржей 2026-02-20, баланс эмитится через onBalanceUpdate.
```

### Ценовые лимиты (`priceLimit.ts`)

```typescript
interface PriceLimitBoundsArgs {
  tradeSymbol: TradeSymbol;
  markPrice: number;
  indexPrice?: number;
  premiumAvg?: number; // Bybit premium-член: EMA(midPrice − mark, 30s); при отсутствии трактуется как 0 (см. PremiumIndexCalculator)
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
