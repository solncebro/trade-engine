# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[2.1.1]: https://github.com/solncebro/trade-engine/releases/tag/v2.1.1
[2.1.0]: https://github.com/solncebro/trade-engine/releases/tag/v2.1.0
[2.0.0]: https://github.com/solncebro/trade-engine/releases/tag/v2.0.0
[1.2.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.2.0
[1.1.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.1.0
[1.0.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.0.0
