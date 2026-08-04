# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Команды

```bash
# Сборка (lint → тесты → tsc)
yarn build

# Юнит-тесты
yarn test

# Проверка типов
npx tsc --noEmit

# Линтинг
yarn lint
yarn lint:fix

# Интеграционные тесты (нужны demo API-ключи в .env.test)
yarn test:integration              # все
yarn test:integration:binance      # Binance
yarn test:integration:bybit        # Bybit
yarn test:integration:e2e-signal   # E2E сигнал→ордер
yarn test:integration:mvp          # spot-fallback + limit-orders + multiple-symbols + error-handling

# Один юнит-тест
npx jest tests/utils.test.ts

# Один интеграционный тест
npx jest --config jest.integration.config.js --runInBand --testPathPatterns=<pattern>
```

**Jest 30** — флаг `--testPathPatterns` (множественное число), не `--testPathPattern`.

## Архитектура

**@solncebro/trade-engine** — библиотека торгового движка для Binance и Bybit с интеграцией Telegram и Firebase.

### Пайплайн: Сигнал → Ордер

1. Сигнал приходит (Telegram / WebSocket)
2. `OrderCalculator.resolveSymbolsForExchanges()` — маппинг символов с учётом префиксов (`1000FLOKI`)
3. `OrderCalculator.createOrderAttributesForSymbol()` — расчёт параметров ордера
4. Если нет данных на futures → `OrderCalculator.enrichWithSpotFallback()` — переключение на spot
5. `ExchangeConnector.createOrder()` — исполнение на бирже

### Подробная документация

| Файл | Содержание |
|------|-----------|
| [`.claude/rules/architecture.md`](.claude/rules/architecture.md) | Архитектура, слои, потоки данных, схема пайплайна |
| [`.claude/rules/exchange-connector.md`](.claude/rules/exchange-connector.md) | ExchangeConnector: подключение, тикеры, префиксы, demo trading |
| [`.claude/rules/order-calculator.md`](.claude/rules/order-calculator.md) | OrderCalculator: все методы расчёта ордеров |
| [`.claude/rules/types.md`](.claude/rules/types.md) | Система типов: OrderParams, OrderResult, маппинги, конфиги |
| [`.claude/rules/services.md`](.claude/rules/services.md) | Telegram, Firebase, Logger, утилиты |
| [`.claude/rules/testing.md`](.claude/rules/testing.md) | Тестирование: команды, паттерны, хелперы, символы |
| [`.claude/rules/code-conventions.md`](.claude/rules/code-conventions.md) | Конвенции: форматирование, импорты, именование, паттерны |
| [`.claude/rules/strategy-trading.md`](.claude/rules/strategy-trading.md) | Слой стратегической торговли: `OrderManager`, базовый `PositionMonitor` (+ хуки, порты `PositionStore`/`MarketDataSource`), подключаемый `GenericPnlMonitor` (opt-in PnL-бот позиций), `ChartGenerator`, модель `MonitoredPosition`, утилиты слоя |
| [`.claude/rules/trend.md`](.claude/rules/trend.md) | Определение тренда: `TrendCalculator` (структура рынка — вершины/впадины, направление, слом, сила 0–100), `TrendMonitor` (живой наблюдатель + событие смены тренда), `formatTrendSummaryMessage` |

### Ключевые модули

- **`src/services/exchangeConnector.ts`** — обёртка над `@solncebro/exchange-engine`. Подключения, тикеры, mark price WebSocket, резолвинг символов, исполнение ордеров; для futures — `futuresPositionMode` (OneWay / Hedge) влияет на авто-`positionSide` в `createOrder` (legacy safety-net). Прямой доступ к клиентам через `connector.spot` / `connector.futures` (с Proxy для kline watchdog при включении). Lazy-init `connector.positionManager` — высокоуровневый API. 5/6-й аргументы конструктора (3.5.0): `klineWatchdogConfig?`, `rateLimitConfig?`. → [подробнее](.claude/rules/exchange-connector.md)
- **`src/core/positionManager.ts`** — `PositionManager`, высокоуровневый семантический API для spot/futures (`openPositionLimit/Market`, `openPositionBatchLimit`, `closePositionLimit/Market`, `closePositionBatchLimit`, `placeStopLoss/TakeProfit`, `cancelOrder/cancelBatchOrders/cancelAllOrders`, `modifyOrder/modifyBatchOrders`, `spotMarketBuyByQuote`, `setLeverage/setMarginMode`, `readPositionState/readAllPositions` — последние два только futures). Все write-операции — через `RateLimitedRequestQueue` + `withRetryOn429` (3.5.0). Скрывает `positionSide`/`positionIdx`/`reduceOnly`/`closePosition`/`workingType`/`triggerDirection`/`triggerBy`/`orderFilter`/`marketUnit` от приложений; принимает бизнес-аргументы (`symbol`, `marketType`, `direction`, `amount`, `price`/`triggerPrice`). На spot `direction='short'` бросает synchronous Error.
- **`src/core/RateLimitedRequestQueue.ts`** (3.5.0) — sliding-window очередь для контроля RPS write-операций.
- **`src/core/withRetryOn429.ts`** (3.5.0) — `withRetryOn429` + `withReadRetry` — retry-обёртки с exponential backoff на 429/5xx.
- **`src/services/klineSubscriptionWatchdog.ts`** (3.5.0) — мониторинг и автоматическое восстановление потерянных kline-подписок.
- **`src/services/premiumIndexCalculator.ts`** — `PremiumIndexCalculator`, per-symbol EMA «премии» (`midPrice − markPrice`, окно 30s) для подачи `premiumAvg` в `OrderCalculator.calculatePriceLimitBounds`; не auto-wired. → [подробнее](.claude/rules/services.md)
- **`src/services/tradifiSymbolGate.ts`** (3.12.0) — `TradifiSymbolGate`, переиспользуемый хранитель «универса без TradFi» (`isAllowed`/`classify`/`filterSymbolList`); опциональный `shouldAllowTradifi` (3.13.0, default `false`) снимает фильтр по явному согласию потребителя. → [подробнее](.claude/rules/services.md)
- **`src/core/orderCalculator.ts`** — статические методы расчёта ордеров, маппинг символов, кредитное плечо, spot fallback. `calculateCloseOrder` сохраняет `positionSide` из исходного `orderParams`. → [подробнее](.claude/rules/order-calculator.md)
- **`src/core/trendCalculator.ts` + `src/core/TrendMonitor.ts`** (3.14.0) — определение тренда актива по структуре рынка (вершины/впадины). `TrendCalculator` — статический расчёт направления (рост/падение/боковик), слома тренда по закрытию и силы 0–100. `TrendMonitor` — живой наблюдатель поверх `MarketDataSource`: вердикт по каждому интервалу + сводка, событие `trendChanged` при смене направления, чистое снятие подписок. `formatTrendSummaryMessage` — текст сводки для Telegram. Не торгует и не шлёт сам. → [подробнее](.claude/rules/trend.md)
- **`src/core/orderExecutor.ts`** — базовый класс исполнения ордеров с TP/SL и аварийным выходом (legacy путь; новые проекты — через `PositionManager`).
- **`src/services/telegram*.ts`** — Telegram-бот (Telegraf) + MTProto-слушатель. → [подробнее](.claude/rules/services.md)
- **`src/services/firebaseServiceBase.ts`** — базовый класс Firestore CRUD с real-time подпиской; `updateData` использует `flattenForFirestoreUpdate` (3.5.0). → [подробнее](.claude/rules/services.md)

#### Слой стратегической торговли (влит из бывшего `@solncebro/ma-trading-core`)

- **`src/core/OrderManager.ts`** — фоновый исполнитель всех ордерных операций (cancel/replace/place/close, batch) с WS+REST verify, retry, per-position FIFO, sub-batch splitting ≤10, RAM-only. → [подробнее](.claude/rules/strategy-trading.md)
- **`src/core/PositionMonitor.ts`** — базовый headless-класс мониторинга позиций: poll-цикл, SL/TP, реконсиляция внешнего закрытия, drain multi-entry, WS-хендлеры, protected-хуки для подклассов; порты `PositionStore` (`positionStore.types.ts`) и `MarketDataSource` (`marketDataSource.types.ts`). → [подробнее](.claude/rules/strategy-trading.md)
- **`src/core/GenericPnlMonitor.ts`** — `extends PositionMonitor`; подключаемый **opt-in** PnL-слой со своим Telegram-ботом позиций (profit/loss alerts, trailing SL, auto-close, SOS halve-at-breakeven, Split-TP, импорт/эфемерные). Пороги через callback `getPnlConfig(): PnlConfig`; app-специфика — через protected-хуки (`onLossThresholdReached`, `onCancelSos`, `resolveInsuranceViewState`, `registerInsuranceCallbackHandlers`, …). Без chaser/insurance-связности. → [подробнее](.claude/rules/strategy-trading.md)
- **`src/chart/ChartGenerator.ts`** — candlestick-PNG через ECharts SSR + resvg (`generateChart` / `generateVolumeMontageChart`). → [подробнее](.claude/rules/strategy-trading.md)
- **`src/types/strategy.ts`** — модель `MonitoredPosition` / `MaValues` / `MaLevel` + константы `VOLUME_SMA_PERIOD`, `MA_LEVEL_LIST`, `ALL_SUPPORTED_INTERVAL_LIST`. → [подробнее](.claude/rules/strategy-trading.md)

### Ключевые принципы

- **Ошибки — не исключения**: `createOrder()` возвращает `errorText` в результате, не бросает. Проверка через `isOrderSuccessful(result)`. Прямые вызовы `connector.spot`/`connector.futures` могут бросать исключения — потребитель обрабатывает их сам.
- **Единая точка входа**: внешние приложения импортируют ТОЛЬКО из `@solncebro/trade-engine`. Прямые импорты из `@solncebro/exchange-engine` запрещены (классы `Exchange` и утилита `formatWebSocketConnectionsReport` НЕ реэкспортируются).
- **Demo trading**: `ExchangeConfig.isDemoMode = true`, никаких ручных URL-переопределений.
- **Биржи**: `@solncebro/exchange-engine` 0.14.0 (установлено локально через `file:../exchange-engine`). Bybit: WebSocket для ордеров.
- **Map-коллекции**: `SymbolMappingByExchange` и `ExchangeConnectorByName` — это `Map`, не объекты.

### Интеграционные тесты

- `.env.test` с `BINANCE_DEMO_API_KEY`, `BINANCE_DEMO_SECRET_KEY`, `BYBIT_DEMO_API_KEY`, `BYBIT_DEMO_SECRET_KEY`
- Тесты автоматически пропускаются при отсутствии ключей (`describeIfCredentials()`)
- Хелперы: `tests/integration/helpers/` — конфиги, символы, WS-эмулятор
- Всегда `--runInBand` (последовательно), таймаут 180 сек
- Интеграционные команды запускаются через `scripts/runIntegrationJest.js`, который очищает proxy-переменные окружения (`HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/GIT_HTTP_PROXY/GIT_HTTPS_PROXY/SOCKS_PROXY/SOCKS5_PROXY` и lowercase-варианты)
- → [подробнее](.claude/rules/testing.md)
