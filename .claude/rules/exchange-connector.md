# ExchangeConnector — подключение к биржам

Файл: `src/services/exchangeConnector.ts`

## Зависимость

Использует `@solncebro/exchange-engine` 0.21.0 (из реестра npm). Все низкоуровневые операции делегируются этой библиотеке. **Прямые импорты из `@solncebro/exchange-engine` сторонними потребителями запрещены** — единая точка входа `@solncebro/trade-engine`.

## Инициализация

```typescript
import { ExchangeNameEnum, PositionModeEnum } from '@solncebro/trade-engine';

const connector = new ExchangeConnector(
  ExchangeNameEnum.Binance,
  { apiKey: '...', secret: '...', isDemoMode: true },
  message => logger.warn(message),
  PositionModeEnum.Hedge,
  klineWatchdogConfig,   // 5-й — опционально (3.5.0)
  rateLimitConfig,       // 6-й — опционально (3.5.0)
  streamWatchdogConfig   // 7-й — опционально (3.6.0): orderbook/publicTrade/markPrice watchdog
);
await connector.initialize();
// → loadTradeSymbols (futures + spot) обёрнут в withReadRetry
// → getOrderRateLimit() → создаётся RateLimitedRequestQueue (если rateLimitConfig не null)
// → installPriceTickSnapper() (3.17.0) — подключает formatPrice/snapPriceToTick к тиковой сетке символов
// → fetchTickers через withReadRetry, периодическое обновление каждые 30 сек
// → klineWatchdog запускается (если включён)
```

Третий параметр `onNotify` — опциональный callback для получения критических уведомлений от биржи. Начиная с `exchange-engine` 0.9.0, обработчик CRITICAL-сообщений **не вызывает `process.exit(1)` автоматически** — потребитель должен реализовать собственную логику завершения при необходимости.

Четвёртый параметр `futuresPositionMode` (по умолчанию `PositionModeEnum.OneWay`) задаёт режим для логики `positionSide` при создании **futures**-ордеров; значение доступно как публичное поле `connector.futuresPositionMode`.

**Пятый параметр `klineWatchdogConfig`** (3.5.0, опционально, `KlineSubscriptionWatchdogConfig`) — настройки `KlineSubscriptionWatchdog`. Если задан, методы `subscribeKlines`/`unsubscribeKlines` оборачиваются Proxy для отслеживания timestamp каждой подписки. Default: `isEnabled: true`. См. `src/services/klineSubscriptionWatchdog.ts`.

**Шестой параметр `rateLimitConfig`** (3.5.0, опционально, `RateLimitConfig | null`):
- `null` — не использовать rate limit вообще.
- `{ writeRequestsPerSecond, intervalMs? }` — статически переопределить.
- `undefined` (default) — динамически читать с биржи через `getOrderRateLimit()` в `initialize()`.

**Седьмой параметр `streamWatchdogConfig`** (3.6.0, опционально, `StreamWatchdogConfigMap`) — per-stream настройки `StreamSubscriptionWatchdog` для **не-kline** публичных потоков: `{ orderbook?, publicTrade?, markPrice? }`, каждый — `StreamWatchdogStreamConfig` (`isEnabled` + grace/cooldown + callbacks `onStale/onRecovered/onRecoveryFailed/onNotify`, вызываемые с инъекцией `marketType`). **Все три по умолчанию OFF** (`isEnabled` нужно явно выставить `true`) — публикация ничего не меняет, пока потребитель не включит. При `isEnabled=true` соответствующие `subscribe*/unsubscribe*` оборачиваются Proxy (обёрнутый handler-ref трекается по watchdog-key, не по handler — корректный unsubscribe при shared handler ref). `markPrice` доступен только на futures (Bybit). `startWatchingMarkPrices` маршрутизируется через проксированный `this.futures`, чтобы markPrice-watchdog видел внутренний handler. Каждый стрим-тип — собственный `StreamSubscriptionWatchdog` с per-stream стратегией (`OrderbookWatchdogStrategy` и т.д., `src/services/streamWatchdogStrategies.ts`): heartbeat-staleness + resubscribe-recovery (orderbook/publicTrade/markPrice). См. раздел `StreamSubscriptionWatchdog` ниже.

## Demo Trading

Включается через `ExchangeConfig.isDemoMode = true`. Библиотека `exchange-engine` сама переключает URL:
- **Binance**: `https://demo-api.binance.com` (spot), `https://demo-fapi.binance.com` (futures)
- **Bybit**: `https://api-demo.bybit.com` (REST), `wss://stream-demo.bybit.com/v5/trade` (WebSocket)

**Никаких ручных URL-переопределений.**

## Прямой доступ к клиентам

ExchangeConnector предоставляет прямой доступ к `ExchangeClient` через геттеры:

```typescript
// Spot-клиент
connector.spot.fetchBalances();   // → AccountBalances
connector.spot.fetchPosition(symbol);

// Futures-клиент
connector.futures.setLeverage(5, 'BTCUSDT');
connector.futures.setMarginMode(MarginModeEnum.Isolated, 'BTCUSDT');
connector.futures.fetchPosition('BTCUSDT');
connector.futures.fetchOrderHistory('BTCUSDT');

// Динамический выбор по marketType
connector.getClient(marketType).amountToPrecision(symbol, amount);
```

Потребители работают с `ExchangeClient` напрямую — без промежуточных обёрток. Обработка ошибок — на стороне потребителя.

### Полный справочник методов ExchangeClient

Все методы доступны через `connector.spot` / `connector.futures`:

**Символы и тикеры:**
- `loadTradeSymbols()` — загрузка торговых символов
- `fetchTickers()` — получение всех тикеров
- `watchTickers()` — подписка на тикеры через WebSocket

**Свечи:**
- `fetchKlines(symbol, interval, since?, limit?)` — получение свечей
- `fetchAllKlines(options: FetchAllKlinesOptions)` — получение всех свечей с пагинацией
- `subscribeKlines(args: SubscribeKlinesArgs)` — подписка на свечи через WebSocket
- `unsubscribeKlines(symbol, interval)` — отписка от свечей
- `resubscribeKlines(symbol, interval)` — переподписка на свечи (явный реконнект WebSocket-стрима)
- `resubscribeKlineList(subscriptionList: { symbol; interval }[])` — пакетная переподписка на несколько пар за один вызов; очередь исходящих команд держит темп внутри `exchange-engine`. Используется `KlineSubscriptionWatchdog` для восстановления массовой просрочки одним вызовом вместо команды на каждую пару

**Баланс:**
- `fetchBalances()` → `AccountBalances` — баланс аккаунта

**Рыночные данные:**
- `fetchOrderBook(symbol)` → `OrderBook` — стакан ордеров
- `fetchTrades(symbol)` → `PublicTrade[]` — публичные сделки
- `fetchMarkPrice(symbol)` → `MarkPrice` — mark price
- `fetchOpenInterest(symbol)` → `OpenInterest` — открытый интерес

**Позиции и маржа:**
- `fetchPosition(symbol)` → `Position` — текущая позиция
- `fetchPositionMode()` → `PositionModeEnum` — режим позиций
- `setPositionMode(mode)` — установка режима позиций
- `setLeverage(leverage, symbol)` — установка кредитного плеча
- `setMarginMode(mode, symbol)` — установка маржинального режима

**Финансирование:**
- `fetchFundingRateHistory(symbol)` → `FundingRateHistory[]` — история ставок финансирования
- `fetchFundingInfo(symbol)` → `FundingInfo` — текущая информация о финансировании

**Ордера:**
- `createOrderWebSocket(args: CreateOrderWebSocketArgs)` → `Order` — создание ордера через WebSocket
- `cancelOrder(symbol, orderId)` → `Order` — отмена ордера
- `getOrder(symbol, orderId)` → `Order` — получение ордера
- `fetchOpenOrders(symbol)` → `Order[]` — открытые ордера
- `fetchOrderHistory(symbol)` → `Order[]` — история ордеров
- `modifyOrder(args: ModifyOrderArgs)` → `Order` — модификация ордера (single)
- `cancelAllOrders(symbol)` → `void` — отмена всех ордеров
- `createBatchOrders(orderList: CreateOrderWebSocketArgs[])` → `CreateBatchOrdersResult` (= `CreateOrderItemResult[]`, 3.16.0, был `Order[]`) — пакетное создание ордеров с per-order результатом (`{ order: Order | null; isSuccess; errorCode; errorText; rateLimit? }`) — по каждой входной заявке видно, встала она и, если нет, что ответила биржа (Binance Futures chunk=5, Bybit linear=20 / spot=10; Bybit идёт через WS если подключён)
- `cancelBatchOrders(symbol, orderIdList)` → `CancelBatchOrdersResult` (= `CancelOrderItemResult[]`) — пакетная отмена с per-order результатами (тип возврата изменён в 0.14.0, был `void`)
- `modifyBatchOrders(orderList: ModifyBatchOrderArgs[])` → `ModifyBatchOrdersResult` (= `ModifyOrderItemResult[]`) — пакетная модификация (0.14.0). Binance Futures REST chunk=5, Bybit linear=20 / spot=10; Bybit идёт через WS если подключён. На Binance Spot бросает `Not supported for spot market`.

**Rate Limit (0.14.0):**
- `getOrderRateLimit()` → `Promise<OrderRateLimit>` — `{ writeRequestsPerSecond, source: 'binance-exchange-info' | 'bybit-documented' | 'fallback' }`. Binance: парсится из `/exchangeInfo` rateLimits → минимум RPS среди ORDERS-ограничений. Bybit: hardcoded 20 RPS (документация V5).

**Аккаунт:**
- `fetchFeeRate(symbol)` → `FeeRate` — комиссии
- `fetchIncome(symbol)` → `Income[]` — доходы/расходы
- `fetchClosedPnl(symbol)` → `ClosedPnl[]` — закрытые PnL

**Public stream (0.14.0, Bybit only — Binance бросает `Not supported`):**
- `subscribeOrderbook(args: SubscribeOrderbookArgs)` / `unsubscribeOrderbook(args)` — Bybit V5 топик `orderbook.{depth}.{symbol}`.
- `subscribePublicTrades(args: SubscribePublicTradesArgs)` / `unsubscribePublicTrades(args)` — Bybit V5 топик `publicTrade.{symbol}`.

**Precision:**
- `amountToPrecision(symbol, amount)` → `number` — округление количества
- `priceToPrecision(symbol, price)` → `number` — округление цены
- `getMinOrderQty(symbol)` → `number` — минимальный объём ордера
- `getMinNotional(symbol)` → `number` — минимальный notional

**WebSocket:**
- `isTradeWebSocketConnected()` → `boolean` — статус торгового WS
- `connectTradeWebSocket()` — подключение торгового WebSocket
- `getWebSocketConnectionInfoList()` → `WebSocketConnectionInfo[]` — информация о WS-соединениях
- `awaitWebSocketConnectionsReady()` → `Promise<void>` (0.13.0+) — дождаться готовности всех WS после подписок (Binance Futures multi-connection; на других стримах сразу resolve).

**User Data Stream — Binance Spot через WebSocket API (exchange-engine d93c52a):** Binance Spot user-data теперь идёт через WebSocket API (класс `BinanceSpotUserDataStream`; listenKey REST удалён биржей 2026-02-20). `UserDataStreamHandlerArgs.onBalanceUpdate?` (опциональный) эмитит баланс по событию `outboundAccountPosition` через типы `BalanceUpdateEvent` / `BalanceUpdateItem`.

## Mark Price (real-time)

`ExchangeConnector` поддерживает подписку на real-time обновления mark price через WebSocket:

```typescript
connector.startWatchingMarkPrices(); // подписка (idempotent)
connector.getMarkPrice('BTCUSDT');   // → MarkPriceUpdate | undefined
connector.stopWatchingMarkPrices();  // отписка + очистка кэша
```

- Данные хранятся в `Map<symbol, MarkPriceUpdate>` — обновляются при каждом WebSocket-событии
- Фильтрует невалидные значения (`markPrice <= 0` или не-finite)
- `disconnect()` автоматически вызывает `stopWatchingMarkPrices()`
- Использует `exchange.futures.subscribeMarkPrices` / `unsubscribeMarkPrices` из `exchange-engine` 0.13.0+

## Тикеры

- Хранятся в `Map<string, Ticker>` с ключом `"marketType:symbol"` (например `"futures:BTCUSDT"`)
- Обновляются каждые 30 секунд через `updateTickers()`
- Получение: `getTicker(symbol, marketType)` → `Ticker | undefined`
- Ticker содержит: `{ lastPrice, priceChangePercent, high, low, ... }`

## Символы с префиксами

Некоторые биржи (особенно Bybit) используют префиксные символы:
- `1000FLOKIUSDT` вместо `FLOKIUSDT`
- `10000QUBICUSDT` вместо `QUBICUSDT`
- `1000000MOGUSDT` вместо `MOGUSDT`

`resolveSymbolWithPrefix(symbol, marketType)` проверяет наличие символа с каждым из префиксов: `[10, 100, 1000, 10000, 100000, 1000000]`.

## Создание ордеров

```typescript
const result = await connector.createOrder({
  symbol: 'BTCUSDT',
  side: OrderSideEnum.Buy,
  amount: 0.001,
  price: 50000,
  type: OrderTypeEnum.Market,
  marketType: MarketTypeEnum.Futures,
});
// result: OrderResult { orderId?, errorText?, actualExchangeParams?, responseData? }
```

Особенности `buildCreateOrderArgs` (3.4.0):
- **Spot vs futures разведены.** На spot НЕ выставляются `positionSide`/`reduceOnly`/`closePosition`/`workingType`/`triggerDirection`/`triggerBy`/`closeOnTrigger` — даже если приложение их передаёт в `orderParams`, биржевой слой их не получит.
- **positionSide (futures).** Явный `orderParams.positionSide` используется без изменений. Если не задан: в OneWay поле не передаётся, в Hedge — smart-inference как safety net (открытие: `Buy → Long`, `Sell → Short`; close при `reduceOnly=true`: `Sell → Long`, `Buy → Short`). Идиоматический путь — `connector.positionManager.*`, где `positionSide` всегда явный, а safety-net не задействован.
- **reduceOnly.** Читается и из top-level `OrderParams.reduceOnly`, и из nested `params.reduceOnly` (top-level ранее терялся, фикс 3.4.0).
- **Дополнительные поля** (futures, если заданы): `triggerBy`, `closeOnTrigger`, `closePosition`, `workingType`, `triggerDirection`. **На spot**: `orderFilter` (Bybit), `marketUnit` (Bybit), `quoteOrderQty`. **Универсально**: `clientOrderId`, `callbackRate` (3.16.0, проценты — скользящий стоп на любом рынке), `activationPrice` (3.16.0, приводится к сетке цены символа).
- **Market.** Поле `price` в `OrderParams` может передаваться для удобства, но для `OrderTypeEnum.Market` не форвардится в wire-параметры.
- **timeInForce.** Все биржи: `IOC` для Market, `GTC` для Limit-like (в т.ч. `StopLimit`/`TakeProfitLimit` на spot).
- **Stop Loss.** `triggerPrice` (через `stopPrice`) и `triggerDirection` если указаны.

## Публичные методы

| Метод / поле | Возвращает | Описание |
|-------|-----------|----------|
| `get spot` | `ExchangeClient` | Прямой доступ к spot-клиенту |
| `get futures` | `ExchangeClient` | Прямой доступ к futures-клиенту |
| `get positionManager` | `PositionManager` | Lazy-init высокоуровневый API ордеров и позиций (3.4.0) |
| `futuresPositionMode` | `PositionModeEnum` | Режим позиций для futures (задаётся в конструкторе, по умолчанию `OneWay`) |
| `initialize()` | `Promise<void>` | Загрузка символов, старт тикеров |
| `resolveSymbolWithPrefix(symbol, marketType)` | `string` | Поиск символа с префиксом |
| `getTicker(symbol, marketType)` | `Ticker \| undefined` | Текущий тикер из кэша |
| `startWatchingMarkPrices()` | `void` | Подписка на real-time mark price (idempotent) |
| `stopWatchingMarkPrices()` | `void` | Отписка и очистка кэша mark price |
| `getMarkPrice(symbol)` | `MarkPriceUpdate \| undefined` | Последний mark price из кэша |
| `createOrder(params)` | `Promise<OrderResult>` | Создание ордера |
| `createBatchOrders(orderParamsList)` | `Promise<OrderResult[]>` | Пакетное создание ордеров; каждый элемент несёт `orderId` при успехе или `errorText` с реальным ответом биржи при отказе (не угадывается по номеру заявки, 3.16.0) |
| `getFuturesSymbols({ excludeTradifi? })` | `Promise<string[]>` | Список фьючерсных символов; `excludeTradifi: true` отсеивает токенизированные TradFi-перпы (акции/ETF/сырьё) по нормализованному `TradeSymbol.isTradifi` (Binance `contractType: TRADIFI_PERPETUAL`, Bybit `symbolType: stock/commodity`; exchange-engine ≥ 0.18.0) |
| `getSpotSymbols()` | `Promise<string[]>` | Список спотовых символов |
| `getClient(marketType)` | `ExchangeClient` | **Raw** клиент по marketType (без watchdog-прокси) |
| `getStreamClient(marketType)` | `ExchangeClient` | **Проксированный** клиент по marketType (3.6.0): stream-консьюмеры подписываются через него, чтобы `StreamSubscriptionWatchdog` оборачивал их handler'ы |
| `getExchangeName()` | `ExchangeNameEnum` | Имя биржи |
| `getAccountId()` | `string` | SHA256 хеш API-ключа (16 символов) |
| `disconnect()` | `Promise<void>` | Остановка тикеров, mark price, закрытие соединения |

## Rate Limiting (3.5.0)

`ExchangeConnector` при `initialize()` опрашивает `getOrderRateLimit()` и создаёт `RateLimitedRequestQueue` с лимитом RPS из биржевого ответа. Эта очередь применяется ко всем write-операциям `PositionManager` (создание/отмена/модификация ордеров, setLeverage/setMarginMode).

**Параметр конструктора `rateLimitConfig`**:
- `null` — не использовать rate limit вообще (очередь не создаётся).
- `{ writeRequestsPerSecond: 10, intervalMs: 1000 }` — статически переопределить (не запрашивать у биржи).
- `undefined` (default) — динамически читать с биржи в `initialize()`.

В случае ошибки `getOrderRateLimit()` используется fallback (15 RPS, source: `'fallback'`).

См. `src/core/RateLimitedRequestQueue.ts`.

## PositionManager — методы

`connector.positionManager` — lazy-init высокоуровневый API (файл `src/core/positionManager.ts`). Помимо одиночных open/close/SL/TP/cancel/modify (см. таблицу выше и `CLAUDE.md`), доступны batch- и read-методы:

| Метод | Возвращает | Описание |
|-------|-----------|----------|
| `openPositionBatchLimit(args: OpenPositionBatchLimitArgs)` | `Promise<OpenPositionBatchLimitResult>` | Пакетное открытие лимитных позиций по одному символу (`itemList`); применяет `applyFuturesSetup` (leverage/marginMode) один раз; пустой `itemList` → `[]` |
| `closePositionBatchLimit(args: ClosePositionBatchLimitArgs)` | `Promise<ClosePositionBatchLimitResult>` | Пакетное закрытие лимитными `reduceOnly`-ордерами по одному символу (`itemList`); пустой `itemList` → `[]` |
| `readPositionState(args: ReadPositionStateArgs)` | `Promise<PositionStateResult>` | **Только futures** (иначе throws). Возвращает discriminated union: `{ kind: 'present', position }` / `{ kind: 'absent', confidence, reason }` / `{ kind: 'ambiguous', reason, position }`. Учитывает Hedge/OneWay (`positionIdx`, `side`) |
| `readAllPositions(args: ReadAllPositionsArgs)` | `Promise<Position[]>` | **Только futures** (иначе throws). `connector.futures.fetchAllPositions()`; при ошибке re-throws |

- `OpenPositionBatchLimitResult` / `ClosePositionBatchLimitResult` = `PositionBatchLimitItemResult[]`, где `PositionBatchLimitItemResult = { isSuccess, orderId: string | null, errorText: string | null }`.
- `PositionStateResult` reasons: `PositionAbsenceReason = 'no_record' | 'zero_contracts' | 'fetch_error'`, `PositionAmbiguityReason = 'side_mismatch' | 'idx_mismatch'`.

## Kline Subscription Watchdog (3.5.0)

Опциональный мониторинг kline-подписок для автоматического восстановления потерянных подписок. Активируется через 5-й аргумент конструктора `klineWatchdogConfig?: KlineSubscriptionWatchdogConfig`.

Если включён, методы `subscribeKlines`/`unsubscribeKlines` на `connector.spot`/`connector.futures` оборачиваются Proxy — каждый incoming kline-handler регистрируется в watchdog, который отслеживает timestamp последнего полученного события для пары `(symbol, interval)`.

**Алгоритм восстановления**:
1. Periodic scan каждые `checkIntervalMs` (default 30 сек) — ищет overdue подписки (нет событий дольше `graceMs`).
2. Для всех overdue сразу → отправка уведомления через `onNotify`, одна пакетная команда `resubscribeKlineList` на весь круг (раньше была отдельная команда `resubscribeKlines` на каждую пару символ+таймфрейм — при массовой просрочке это било по лимиту запросов биржи и рвало соединение).
3. Если переподписка не восстановила поток → REST refetch последних `restRefetchLimit` свечей + replay user-handler.
4. Cooldown между восстановлениями: `recoveryCooldownMs` (default 120 сек), `recoveryFailCooldownMs` (default 600 сек после `recoveryFailCountThreshold` неудач).

Диагностика: `KlineSubscriptionWatchdog.getDiagnosticInfo()` → `{ totalSubscriptions, overdueCount, inProgressCount, suppressedCount, tickCount, lastTickTimestamp }`.

См. `src/services/klineSubscriptionWatchdog.ts`.

## Stream Subscription Watchdog (3.6.0)

Обобщённый `StreamSubscriptionWatchdog` (`src/services/streamSubscriptionWatchdog.ts`) — единый, stream-type-agnostic мониторинг здоровья WS-подписок для **не-kline** публичных потоков (orderbook / publicTrade / markPrice). Общее ядро (scan loop, cooldown/fail-escalation, suppression, parallel-batch recovery, heartbeat, notify + структурные события) идентично для всех типов; различия инкапсулированы в `StreamWatchdogStrategy` (`src/services/streamWatchdogStrategies.ts`):

- **`computeAgeMs(entry, now)`** — для orderbook/publicTrade/markPrice это flat heartbeat-age (`now − freshnessTimestamp`); для kline (будущая миграция) — interval-projection.
- **`recover(key)`** — orderbook → `resubscribeOrderbook`; publicTrade → `resubscribePublicTrades`; markPrice → `resubscribeMarkPrices` (resubscribe-only, без REST-replay → `suppressDuringRecovery=false`).

Watchdog handler-агностичен: примитивы `registerKey/recordFreshness/isSuppressed/unregisterKey`. Оборачивание конкретного handler'а (запись freshness + проверка suppression) делает Proxy в `ExchangeConnector.createWatchdogClientProxy` — там же известен тип handler'а. Активируется per-stream через 7-й аргумент конструктора `streamWatchdogConfig` (см. выше), **default OFF**.

**События** (`StreamWatchdogCallbacks`): `onStreamStale` (fires на детекте overdue, до recovery — потребитель может инвалидировать кэш, напр. coin-listing обнуляет bestAsk), `onStreamRecovered`, `onStreamRecoveryFailed`, `onNotify` (Telegram-сводка). ExchangeConnector инъектирует `marketType` в события (watchdog per-marketType).

Диагностика: `StreamSubscriptionWatchdog.getDiagnosticInfo()` → `{ streamType, totalSubscriptions, overdueCount, inProgressCount, suppressedCount, tickCount, lastTickTimestamp }`.

> **Дублирование с KlineSubscriptionWatchdog (TODO):** kline-watchdog пока отдельный класс с собственной (overlapping) машинерией + богатым interval-grouped Telegram-форматированием. Целевое состояние — мигрировать kline в `StreamSubscriptionWatchdog` как `KlineWatchdogStrategy` (interval-projection staleness + resubscribe+fetchKlines+replay recovery), оставив `KlineSubscriptionWatchdog` тонким back-compat shim. Отложено (затрагивает живой ma-chaser; чисто внутренний DRY без функционального изменения).

## Read Retry (3.5.0)

В `initialize()` и `updateTickers()` вызовы `loadTradeSymbols` / `fetchTickers` обёрнуты в `withReadRetry()` — retry с exponential backoff на сетевых ошибках и 429/5xx. См. `src/core/withRetryOn429.ts`.

## Обработка ошибок

`createOrder()` — единственный метод с внутренним try/catch. Возвращает `OrderResult.errorText` вместо исключения. Если ошибка является `ExchangeError`, то `OrderResult.errorCode` заполняется кодом ошибки биржи.

Все остальные операции (позиции, баланс, leverage, margin mode, ордерная книга и т.д.) выполняются через `connector.spot` / `connector.futures` напрямую. Обработка ошибок — ответственность потребителя.

Это ключевой принцип: код вызывающей стороны проверяет `isOrderSuccessful(result)` для ордеров или оборачивает прямые вызовы клиента в try/catch.
