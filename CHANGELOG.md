# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[3.0.1]: https://github.com/solncebro/trade-engine/releases/tag/v3.0.1
[3.0.0]: https://github.com/solncebro/trade-engine/releases/tag/v3.0.0
[2.2.0]: https://github.com/solncebro/trade-engine/releases/tag/v2.2.0
[2.1.1]: https://github.com/solncebro/trade-engine/releases/tag/v2.1.1
[2.1.0]: https://github.com/solncebro/trade-engine/releases/tag/v2.1.0
[2.0.0]: https://github.com/solncebro/trade-engine/releases/tag/v2.0.0
[1.2.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.2.0
[1.1.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.1.0
[1.0.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.0.0
