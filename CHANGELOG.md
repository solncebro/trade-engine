# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.5.0] - 2026-05-17

### Added

**Reliability-инфраструктура**:
- **`RateLimitedRequestQueue`** (`src/core/RateLimitedRequestQueue.ts`) — sliding-window очередь для write-операций с заданным RPS. Args: `{ rateLimit, intervalMs?, loggerLabel? }`. Логирует первый throttle.
- **`withRetryOn429`** и **`withReadRetry`** (`src/core/withRetryOn429.ts`) — функциональные retry-обёртки на 429/5xx с exponential backoff и поддержкой `Retry-After`. Args: `{ fn, contextLabel, maxRetries?, baseDelayMs? }`.
- **`KlineSubscriptionWatchdog`** (`src/services/klineSubscriptionWatchdog.ts`) — мониторинг и автоматическое восстановление потерянных kline-подписок. Periodic scan → resubscribe → REST refetch + replay user handler. API диагностики `getDiagnosticInfo()`.

**ExchangeConnector**:
- 5-й и 6-й аргументы конструктора: `klineWatchdogConfig?: KlineSubscriptionWatchdogConfig` (опциональный мониторинг) и `rateLimitConfig?: RateLimitConfig | null` (override rate limit).
- При `initialize()` динамически опрашивает `getOrderRateLimit()` и создаёт `RateLimitedRequestQueue` для write-операций (используется через `PositionManager`).
- `loadTradeSymbols` и `fetchTickers` теперь обёрнуты в `withReadRetry`.
- Геттеры `spot` и `futures` возвращают Proxy с watchdog-обёрткой `subscribeKlines`/`unsubscribeKlines` (если watchdog включён).

**PositionManager** (расширения 3.5.0):
- **`cancelAllOrders(args: CancelAllOrdersArgs)`** — высокоуровневая обёртка над `client.cancelAllOrders(symbol)` с queue+retry.
- **`cancelBatchOrders(args)`** теперь возвращает `Promise<CancelBatchOrdersResult>` (per-order результаты `{ orderId, isSuccess, errorCode, errorText }`).
- **`modifyOrder(args: PositionManagerModifyOrderArgs)`** — высокоуровневая модификация одного ордера (price/amount/triggerPrice).
- **`modifyBatchOrders(args: PositionManagerModifyBatchOrdersArgs)`** — массовая модификация ордеров (Binance Futures REST chunk=5, Bybit linear=20 / spot=10; Bybit через WS если подключён). На Binance Spot бросает `Not supported for spot market`.
- Все write-операции (open/close/cancel/modify/setLeverage/setMarginMode) теперь идут через `withRetryOn429` и write-очередь.
- Constructor принимает опциональный `queue?: RateLimitedRequestQueue`. Если не передан, очередь берётся у `ExchangeConnector` (`getWriteQueue()`) **на каждый вызов** — гарантирует актуальный RPS из `initialize()` (раньше очередь фиксировалась при первом обращении к `positionManager` и могла навсегда остаться на fallback).

**FirebaseServiceBase**:
- `updateData(data)` теперь корректно обрабатывает вложенные объекты через внутреннюю утилиту `flattenForFirestoreUpdate()` — превращает `{ a: { b: 1 } }` в `{ "a.b": 1 }` (dot-notation, как требует Firestore `documentReference.update()`).

**Type re-exports** (из `@solncebro/exchange-engine` 0.14.0):
- `CancelBatchOrdersResult`, `CancelOrderItemResult`
- `OrderRateLimit`, `OrderRateLimitSource`
- `ModifyBatchOrderArgs`, `ModifyBatchOrdersResult`, `ModifyOrderItemResult`
- `MarkPriceHandler`, `PriceLimitRisk`, `LeverageFilter`, `TradingFunding`
- `BalanceUpdateEvent`, `BalanceUpdateItem`, `BalanceUpdateHandler` (commit `d93c52a` — Binance Spot user-data через WebSocket API; событие `outboundAccountPosition → onBalanceUpdate`)

**Export из entry** (`src/index.ts`) — новые типы PositionManager: `PositionManagerModifyOrderArgs`, `PositionManagerModifyBatchOrdersArgs`, `PositionManagerModifyBatchOrderItem`, `CancelAllOrdersArgs`. Также: `RateLimitedRequestQueue` + `RateLimitedRequestQueueArgs`, `KlineSubscriptionWatchdog` + `KlineSubscriptionWatchdog*` типы, `withRetryOn429`, `withReadRetry` + `WithRetryOn429Args`, `WithReadRetryArgs`, `RateLimitConfig`.

### Changed

- **Upgraded `@solncebro/exchange-engine` from 0.13.0 to 0.14.0** (commit `d93c52a` — Binance Spot user-data перестроен на WebSocket API; установлено локально через `"file:../exchange-engine"`; не из npm registry — версия копится для будущей публикации).
- `ExchangeClient.cancelBatchOrders` теперь возвращает `Promise<CancelBatchOrdersResult>` (`CancelOrderItemResult[]`) вместо `Promise<void>` (BREAKING в exchange-engine 0.14.0; миграция не требуется для consumers, игнорирующих возврат).
- **Принцип единой точки входа**: класс `Exchange` (factory) и утилита `formatWebSocketConnectionsReport` из `@solncebro/exchange-engine` НЕ реэкспортируются — внешние приложения работают только через `@solncebro/trade-engine`.

### Fixed (релиз-ревью 3.5.0)

- **`KlineSubscriptionWatchdog.stop()`** очищает все внутренние коллекции (`subscribedHandlerByKey`, `subscribedIntervalByKey`, `lastKlineByKey`, `recoveryStateByKey`, `suppressedKeySet`) — ранее `subscribedHandlerByKey`/`subscribedIntervalByKey`/`lastKlineByKey` оставались, и после `stop()`+`start()` старые подписки сразу считались overdue и реплеились в устаревшие хендлеры.
- **`PositionManager`** больше не фиксирует write-очередь при первом обращении: берёт её у `ExchangeConnector.getWriteQueue()` на каждый вызов, поэтому write-операции, выполненные до завершения `initialize()`, после него используют актуальный RPS (раньше могли навсегда остаться на fallback).
- **`withRetryOn429`** учитывает заголовок `Retry-After` не только на `429`, но и на `5xx` (биржевые maintenance-окна отдают `Retry-After` на `503`) — раньше на `5xx` всегда применялся exponential backoff.
- **`ExchangeConnector`** пропускает тик `updateTickers`, если предыдущий ещё не завершился (защита от наложения параллельных обновлений при медленном `withReadRetry`).
- **`RateLimitedRequestQueue`** логирует throttling по скользящему окну (60s) вместо одного раза за весь процесс — восстановлена наблюдаемость повторных эпизодов троттлинга.

### Notes on exchange-engine 0.14.0 (commit `d93c52a`)

- `ExchangeClient.getOrderRateLimit()` → `Promise<OrderRateLimit>` — per-UID write RPS (Binance: парсится из `/exchangeInfo` rateLimits; Bybit: hardcoded 20 RPS из документации V5; fallback 15 RPS).
- Bybit V5 publicTrade/orderbook подписки (`subscribeOrderbook`, `subscribePublicTrades`) — Binance бросает `Not supported`.
- Типы `OrderBookUpdate`, `OrderBookHandler`, `PublicTradeHandler`, `SubscribeOrderbookArgs`, `SubscribePublicTradesArgs`.
- `ExchangeClient.awaitWebSocketConnectionsReady()` — дождаться готовности WS после subscribe (Binance Futures multi-connection).
- `ExchangeClient.modifyBatchOrders(orderList)` → `Promise<ModifyBatchOrdersResult>` — REST для всех бирж + WS для Bybit. Binance Futures chunk=5, Bybit linear=20 / spot=10. На Binance Spot — `Not supported`. Типы `ModifyBatchOrderArgs`, `ModifyOrderItemResult`, `ModifyBatchOrdersResult`.
- BREAKING: тип возврата `cancelBatchOrders` (см. Changed выше).
- Commit `d93c52a` поверх релиза 0.14.0: Binance Spot user-data перестроен на WebSocket API (listenKey REST удалён биржей 2026-02-20); новый класс `BinanceSpotUserDataStream`, типы `BalanceUpdateEvent`/`BalanceUpdateItem`/`BalanceUpdateHandler`, опциональный `UserDataStreamHandlerArgs.onBalanceUpdate`.

См. полный changelog: `/Users/sol/dev/solncebro/exchange-engine/CHANGELOG.md`.

## [3.4.0] - 2026-04-30

### Added
- **`PositionManager`** (`src/core/positionManager.ts`) — высокоуровневый API поверх `ExchangeConnector`: открытие/закрытие позиций (limit и market), `placeStopLoss` / `placeTakeProfit`, `cancelOrder` / `cancelBatchOrders`, `spotMarketBuyByQuote`, `setLeverage`, `setMarginMode`. Скрывает от приложений детали вроде `positionSide`, `reduceOnly`, `workingType`, `triggerBy`, `orderFilter`, `marketUnit` и различия Binance/Bybit; вход — бизнес-аргументы (`symbol`, `marketType`, `direction`, `amount`, `price` / `triggerPrice`). На spot при `direction='short'` — синхронный `Error`
- **`ExchangeConnector.positionManager`** — геттер с lazy-init экземпляра `PositionManager`
- Экспорт из entry (`src/index.ts`): `PositionManager` и типы аргументов `Direction`, `StopOrderType`, `OpenPositionLimitArgs`, `OpenPositionMarketArgs`, `ClosePositionLimitArgs`, `ClosePositionMarketArgs`, `PlaceStopLossArgs`, `PlaceTakeProfitArgs`, `CancelOrderArgs`, `CancelBatchOrdersArgs`, `SpotMarketBuyByQuoteArgs`, `SetLeverageArgs`, `SetMarginModeArgs`
- **`OrderParams`**: опциональные `triggerBy`, `workingType`, `reduceOnly` (top-level), `closeOnTrigger`, `closePosition`, `orderFilter`, `marketUnit`, `trailingDelta`, `quoteOrderQty`, `clientOrderId`
- Реэкспорт из `@solncebro/exchange-engine` через `src/types/index.ts`: `MarketUnitEnum`, `OrderFilterEnum`, `TriggerByEnum`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.12.1 to **0.13.0** (в т.ч. `OrderTypeEnum.StopLimit` / `TakeProfitLimit`, расширение `CreateOrderWebSocketArgs`, отчёт по WebSocket-соединениям, `fetchPositionMode` для Bybit и др. — см. changelog `exchange-engine`)
- **`ExchangeConnector.buildCreateOrderArgs()`**: раздельная сборка для spot и futures; на spot не уходят futures-only поля; на futures пробрасываются новые поля; `reduceOnly` учитывается и из top-level `OrderParams.reduceOnly`, и из `params.reduceOnly`; в Hedge при отсутствии `positionSide` выполняется вывод по `(side, reduceOnly)` с записью предупреждения в лог (для явного контракта рекомендуется `PositionManager`)

### Fixed
- **`OrderCalculator.calculateCloseOrder()`** переносит `positionSide` из исходного `orderParams` в параметры close-ордера (корректная работа в Hedge)
- Top-level **`OrderParams.reduceOnly`** больше не игнорируется при сборке аргументов ордера

## [3.3.1] - 2026-04-24

### Added
- `ExchangeConnector`: четвёртый опциональный аргумент конструктора `futuresPositionMode` (по умолчанию `PositionModeEnum.OneWay`) и публичное поле `readonly futuresPositionMode` — режим для логики `positionSide` при создании futures-ордеров

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.12.0 to 0.12.1
- `ExchangeConnector.buildCreateOrderArgs()`: в режиме **Hedge** при отсутствии явного `orderParams.positionSide` автоматически выставляется `Long` / `Short` по стороне ордера; в режиме **OneWay** (по умолчанию) `positionSide` автоматически не подставляется

### Fixed
- Явный реэкспорт типа `MarkPriceUpdate` из публичного entry (`src/types/index.ts`)

## [3.3.0] - 2026-04-24

### Added
- `ExchangeConnector.startWatchingMarkPrices()` — подписка на real-time обновления mark price через WebSocket
- `ExchangeConnector.stopWatchingMarkPrices()` — отписка и очистка кэша mark price
- `ExchangeConnector.getMarkPrice(symbol)` — получение последнего mark price из кэша (`MarkPriceUpdate | undefined`)
- `OrderCalculator.calculatePriceLimitBounds(args)` — расчёт ценовых лимитов (min/max) для символа с учётом exchange-specific правил (Bybit `bybitRiskParameters`, Binance `multiplierUp/Down`)
- Новые типы: `PriceLimitBounds`, `PriceLimitBoundsArgs` (реэкспортируются из `src/types/priceLimit.ts`)
- `EntityWithErrorText.errorCode?: number | string` — числовой или строковый код ошибки биржи (заполняется из `ExchangeError.code` при ошибке создания ордера)
- `OrderResult.attemptCount?: number` — количество попыток создания ордера
- Новый реэкспорт из `@solncebro/exchange-engine`: `MarkPriceUpdate`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.11.0 to 0.12.0
- `ExchangeConnector.disconnect()` теперь вызывает `stopWatchingMarkPrices()` при отключении

### Notes on exchange-engine 0.12.0
- `ExchangeClient` interface: новые методы подписки на mark price — `subscribeMarkPrices(handler)`, `unsubscribeMarkPrices(handler)`
- `MarkPriceUpdate` — нормализованное событие обновления mark price (symbol, markPrice, indexPrice?, timestamp)

## [3.2.0] - 2026-04-17

### Added
- New type re-exports from `@solncebro/exchange-engine`: `OrderUpdateEvent`, `PositionUpdateEvent`, `OrderUpdateHandler`, `PositionUpdateHandler`, `UserDataStreamHandlerArgs`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.10.0 to 0.11.0

### Notes on exchange-engine 0.11.0
- `ExchangeClient` interface: новые методы User Data Stream — `connectUserDataStream(handler)`, `disconnectUserDataStream()`, `isUserDataStreamConnected()`
- `OrderUpdateEvent` — нормализованное событие обновления ордера (symbol, orderId, side, status, price, avgPrice, amount, filledAmount, timestamp)
- `PositionUpdateEvent` — нормализованное событие обновления позиции (symbol, side, size, entryPrice, markPrice, unrealisedPnl, leverage, liquidationPrice, positionSide, timestamp)

## [3.1.5] - 2026-04-14

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.9.1 to 0.10.0

### Notes on exchange-engine 0.10.0
- `BybitLinear.setMarginMode()` is now a no-op — Bybit manages margin mode at account level, not per-symbol
- `BybitPublicStream`: improved multi-connection support with automatic topic chunking (max 200 topics per connection) and batched subscribe messages (max 10 topics per SUBSCRIBE request)
- `BybitBaseClient.getOrder()`: now checks realtime (open orders) first, then falls back to order history
- `BybitBaseClient.submitOrder()`: now checks `isConnected()` before sending via WebSocket
- `BybitLinear.setLeverage()`: improved error handling for error code 110043 (leverage not modified)
- `normalizeBybitKlines()`: fixed kline sorting order (now ascending chronological)

## [3.1.4] - 2026-04-13

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.7.1 to 0.9.1

### Notes on exchange-engine 0.8.0–0.9.1
- `ExchangeClient.resubscribeKlines(symbol, interval)` — new method for explicit WebSocket stream reconnection
- `TradeSymbol.contractType: string` — new field identifying contract type (PERPETUAL, TRADIFI_PERPETUAL, etc.)
- `BaseExchangeClient.createNotifyHandler()` no longer calls `process.exit(1)` after CRITICAL messages — consumers must implement their own shutdown logic if needed
- `BaseHttpClient` non-GET HTTP errors now throw readable `Error` messages instead of raw `AxiosError`

## [3.1.3] - 2026-04-08

### Added
- `OrderParams`: new optional `positionSide?: PositionSideEnum` field — allows explicit control of position side when creating futures orders

### Changed
- `ExchangeConnector.buildCreateOrderArgs()`: now respects explicit `positionSide` in `orderParams`, falling back to automatic resolution (`Long` for Buy, `Short` for Sell) only on non-Binance exchanges and when not explicitly set

## [3.1.2] - 2026-04-01

### Added
- `ExchangeConnector` constructor: new optional `onNotify` parameter — when provided, passes the callback to `exchange-engine` for handling critical exchange notifications
- New type re-exports from `@solncebro/exchange-engine`: `ExchangeArgs`, `ExchangeLogger`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.6.3 to 0.7.1

## [3.0.2] - 2026-03-31

### Added
- `OrderCalculator.calculateLimitOrderWithPriceAdjustment()`: new optional `exchangeClient` parameter — when provided, applies `amountToPrecision` and `priceToPrecision` to the resulting `amount` and `price`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.6.2 to 0.6.3

## [3.0.1] - 2026-03-26

### Fixed
- `createLogger()` now normalizes `BETTERSTACK_ENDPOINT` before passing it to `@logtail/pino`:
  - trims leading/trailing spaces
  - keeps endpoint unchanged when it already starts with `http://` or `https://`
  - prepends `https://` when only host is provided

## [3.0.0] - 2026-03-24

### Breaking Changes
- **ExchangeConnector**: removed wrapper methods — consumers now use `connector.spot.*` / `connector.futures.*` directly:
  - Removed: `fetchPosition()`, `setLeverage()`, `setMarginMode()`, `isTradeWebSocketConnected()`, `connectTradeWebSocket()`, `getWebSocketConnectionInfoList()`, `fetchBalance()`, `fetchOrderHistory()`, `getMinOrderQty()`, `getMinNotional()`, `fetchPositionMode()`
  - These methods no longer swallow errors internally — callers handle exceptions via try/catch
- **ExchangeConnector.resolveSymbolWithPrefix()**: now requires `marketType` parameter — `resolveSymbolWithPrefix(symbol, marketType)`
- **OrderCalculator.calculateLimitOrderWithPriceAdjustment()**: changed from positional parameters to a single `CalculateLimitOrderWithPriceAdjustmentArgs` object
- Removed re-exports: `normalizeBinanceKlineWebSocketMessage`, `normalizeBybitKlineWebSocketMessage`
- Removed raw type re-exports: `BinanceContinuousKlineMessageRaw`, `BinanceWebSocketKlineRaw`, `BybitKlineMessageRaw`, `BybitPublicTradeDataRaw`, `BybitTradeMessageRaw`, `BybitWebSocketKlineRaw`, `BybitWebSocketMessageRaw`

### Added
- `ExchangeConnector.spot` / `ExchangeConnector.futures` getters for direct `ExchangeClient` access
- New type re-exports from `@solncebro/exchange-engine`: `AccountBalances`, `ClosedPnl`, `CreateOrderWebSocketArgs`, `FeeRate`, `FetchAllKlinesOptions`, `Income`, `MarkPrice`, `ModifyOrderArgs`, `OpenInterest`, `OrderBook`, `OrderBookLevel`, `PublicTrade`, `TradeSymbol`, `TradeSymbolBySymbol`, `TradeSymbolFilter`, `WebSocketConnectionInfo`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.4.0 to 0.6.0
- `OrderCalculator.setupLeverageAndMarginModeEnum()` now calls `connector.futures.setLeverage()` / `connector.futures.setMarginMode()` directly
- Documentation and project rules synced with v3 API: direct `connector.spot` / `connector.futures` usage and updated error-handling contract
- `yarn build` now runs `yarn lint` before tests and `tsc`; `prepublishOnly` delegates to `yarn build` (lint is not duplicated)

### Fixed
- Integration test runner now strips proxy environment variables to avoid `403` when the execution environment injects a local proxy.
- `ExchangeConnector.createOrder()` fixes for Binance demo flows:
  - For `OrderTypeEnum.Market`, `price` is not forwarded to the exchange order-creation params.
  - For Binance futures, `positionSide` is not sent to avoid conflicts with one-way position settings.

## [2.2.0] - 2026-03-14

### Changed
- `ExchangeConnector.buildCreateOrderArgs()`: applies `amountToPrecision` and `priceToPrecision` to `amount` and `price` before sending to exchange client
- `OrderCalculator.createOrderAttributesForMarketType()`: removed `parseFloat()` wrapper around `amountToPrecision` (now returns `number`)
- Removed redundant `parseFloat()` from `stopPrice` in `buildCreateOrderArgs`
- Upgraded `@solncebro/exchange-engine` from 0.3.3 to 0.4.0

## [2.1.1] - 2026-03-14

### Changed
- `createLogger`: added pino error serializer via `pino.stdSerializers.wrapErrorSerializer` that preserves `code` and `exchange` fields on serialized errors
- Upgraded `@solncebro/exchange-engine` from 0.3.2 to 0.3.3

## [2.1.0] - 2026-03-13

### Changed
- `ExchangeConnector`: 5 методов получили опциональный `marketType?` для универсальной работы со spot и futures:
  - `fetchPosition(symbol, marketType?)`
  - `setLeverage(symbol, leverage, marketType?)`
  - `setMarginMode(symbol, marginMode, marketType?)`
  - `isTradeWebSocketConnected(marketType?)`
  - `connectTradeWebSocket(marketType?)`
- `OrderCalculator.setupLeverageAndMarginModeEnum()`: явный `MarketType.Futures` для самодокументируемости
- Upgraded `@solncebro/exchange-engine` from 0.3.1 to 0.3.2

## [2.0.0] - 2026-03-12

### Breaking Changes
- All re-exported enums renamed with `Enum` suffix to match `@solncebro/exchange-engine` 0.3.0:
  - `ExchangeName` -> `ExchangeNameEnum`
  - `OrderSide` -> `OrderSideEnum`
  - `OrderType` -> `OrderTypeEnum`
  - `MarginMode` -> `MarginModeEnum`
  - `TradeSymbolType` -> `TradeSymbolTypeEnum`
  - `TimeInForce` -> `TimeInForceEnum`
- Ticker property changes (from `exchange-engine` 0.3.0):
  - `ticker.close` -> `ticker.lastPrice`
  - `ticker.percentage` -> `ticker.priceChangePercent`
- `ExchangeConnector.createOrder()` now uses typed `CreateOrderWebSocketArgs` instead of `params: Record<string, unknown>`:
  - `hedgeMode: true` replaced with `positionSide: PositionSideEnum.Long/Short`
  - `timeInForce` uses `TimeInForceEnum` values
  - `triggerPrice` in params replaced with `stopPrice` field
  - `reduceOnly` is now a direct field

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.2.0 to 0.3.0
- Added `sideEffects: false` to package.json for tree-shaking
- Added `declarationMap` for better IDE navigation
- Added lint check to `prepublishOnly` pipeline
- Updated `.npmignore` with comprehensive exclusions
- README.md fully rewritten with actual API examples

### Fixed
- Unused imports removed from integration tests
- ESLint config: jest config files excluded from linting

## [1.2.0] - 2026-03-10

### Added
- Signal emulator test infrastructure (`SignalEmulatorServer`, `connectClient`, `waitForMessage`)
- AI structure file for codebase documentation

### Changed
- Migrated from CCXT to `@solncebro/exchange-engine` 0.2.0
- All exchange operations now use `exchange-engine` unified API

## [1.1.0] - 2026-03-06

### Added
- Integration test suite: Binance, Bybit, E2E signal, spot-fallback, limit-orders, multiple-symbols, error-handling
- Test helpers: `describeIfCredentials()`, `waitForTickers()`, `calculateTestAmount()`
- Demo trading support via `ExchangeConfig.demo`
- Jest integration config with 180s timeout

### Changed
- Removed testnet support in favor of demo trading

## [1.0.0] - 2026-03-03

### Added
- `ExchangeConnector` with futures/spot support, ticker caching, symbol prefix resolution
- `OrderCalculator` with static methods: `resolveSymbolsForExchanges`, `createOrderAttributesForSymbol`, `enrichWithSpotFallback`, `calculateCloseOrder`, `calculateLimitOrderWithPriceAdjustment`, `setupLeverageAndMarginMode`
- `OrderExecutor` base class with TP/SL and emergency exit
- `TelegramNotifier` (Telegraf bot) and `TelegramMessageListener` (MTProto)
- `TelegramCommandHandler<T>` with typed boolean/numeric settings
- `FirebaseService<T>` with Firestore CRUD and real-time subscriptions
- `ConfigManager` for environment variable validation
- Utility functions: `isOrderSuccessful`, `isSpot`, `normalizeSymbol`, `formatTimestamp`, `createLogger`
- Error-as-value pattern for all trading operations

[3.4.0]: https://github.com/solncebro/trade-engine/releases/tag/v3.4.0
[3.3.1]: https://github.com/solncebro/trade-engine/releases/tag/v3.3.1
[3.3.0]: https://github.com/solncebro/trade-engine/releases/tag/v3.3.0
[3.2.0]: https://github.com/solncebro/trade-engine/releases/tag/v3.2.0
[3.1.5]: https://github.com/solncebro/trade-engine/releases/tag/v3.1.5
[3.1.4]: https://github.com/solncebro/trade-engine/releases/tag/v3.1.4
[3.1.3]: https://github.com/solncebro/trade-engine/releases/tag/v3.1.3
[3.1.2]: https://github.com/solncebro/trade-engine/releases/tag/v3.1.2
[3.0.2]: https://github.com/solncebro/trade-engine/releases/tag/v3.0.2
[3.0.1]: https://github.com/solncebro/trade-engine/releases/tag/v3.0.1
[3.0.0]: https://github.com/solncebro/trade-engine/releases/tag/v3.0.0
[2.2.0]: https://github.com/solncebro/trade-engine/releases/tag/v2.2.0
[2.1.1]: https://github.com/solncebro/trade-engine/releases/tag/v2.1.1
[2.1.0]: https://github.com/solncebro/trade-engine/releases/tag/v2.1.0
[2.0.0]: https://github.com/solncebro/trade-engine/releases/tag/v2.0.0
[1.2.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.2.0
[1.1.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.1.0
[1.0.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.0.0
