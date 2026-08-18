# Архитектура trade-engine

## Общая схема

```
Сигнал (Telegram/WebSocket)
  → TelegramMessageListener / WebSocket клиент
    → Парсинг символа из заголовка сигнала
      → OrderCalculator.resolveSymbolsForExchanges()
        → OrderCalculator.createOrderAttributesForSymbol()
          → [если нет данных на futures] OrderCalculator.enrichWithSpotFallback()
            → ExchangeConnector.createOrder()
              → OrderCalculator.calculateCloseOrder() (TP/SL)
```

С 3.4.0 параллельно доступен путь **`connector.positionManager.*`** (открытие/закрытие, SL/TP) без ручной сборки `OrderParams` — см. `positionManager.ts` и `.claude/rules/exchange-connector.md`.

## Слои

### 1. Транспортный слой (получение сигналов)

- **TelegramMessageListener** — MTProto-клиент (`telegram` lib), слушает сообщения в каналах. Extends `EventEmitter`, поддерживает множественные обработчики.
- **WebSocket** — внешний WS-сервер отправляет `TestMessage` с полями `{sendTime, scrapedTime, sourceTime, source, title, id}`.
- Отдельного standalone-эмулятора `websocketEmulator.utils.ts` в библиотеке больше нет — он принадлежал приложению-потребителю и был удалён; вместе с ним из зависимостей убраны `ws`/`@types/ws`.

### 2. Бизнес-логика (расчёт ордеров)

**OrderCalculator** — статический класс, центр вычислений:

| Метод | Назначение |
|-------|-----------|
| `resolveSymbolsForExchanges()` | Маппинг символов → биржевые форматы (с учётом префиксов 1000FLOKI и т.д.) |
| `createOrderAttributesForSymbol()` | Расчёт параметров ордера: цена, объём, сторона, проверка 24h% роста |
| `enrichWithSpotFallback()` | Замена ошибок "No price data" на спот-ордера |
| `calculateLimitOrderWithPriceAdjustment()` | Корректировка цены лимитного ордера на процент |
| `calculateCloseOrder()` | Создание TP/SL ордеров с `reduceOnly`, `triggerPrice` и копированием `positionSide` из исходного orderParams (3.4.0) |
| `setupLeverageAndMarginModeEnum()` | Установка кредитного плеча и маржинального режима |
| `getUniqueSymbolCountFromMapping()` | Подсчёт уникальных символов для распределения объёма |

**OrderExecutor** — базовый класс для наследования:
- `createOrder()` — выполнение ордера через ExchangeConnector
- `createCloseOrder()` — TP/SL/аварийный выход (emergency exit → market order)

### 3. Коннекторы бирж

**ExchangeConnector** — обёртка над `@solncebro/exchange-engine` 0.22.0 (из реестра npm):

| Компонент | Детали |
|-----------|--------|
| Подключение | `initialize()` загружает символы futures + spot (через `withReadRetry`), запускает тикеры (тоже `withReadRetry`), разрешает rate limit |
| Тикеры | Кэш `Map<string, Ticker>`, ключ `"marketType:symbol"`, обновление каждые 30 сек |
| Mark price | опционально `startWatchingMarkPrices()` / `getMarkPrice()` / `stopWatchingMarkPrices()` |
| Символы | `resolveSymbolWithPrefix()` проверяет префиксы [10, 100, 1000, 10000, 100000, 1000000] |
| Ордера | `createOrder()` через WebSocket (`createOrderWebSocket`) |
| PositionManager | `positionManager` — lazy-init высокоуровневый API (3.4.0); расширен `modifyOrder/modifyBatchOrders/cancelAllOrders` (3.5.0) |
| Прямой доступ | `spot` / `futures` геттеры → `ExchangeClient` напрямую (с Proxy для kline watchdog, если включён) |
| Rate Limit (3.5.0) | при `initialize()` — `getOrderRateLimit()` → `RateLimitedRequestQueue` для write-операций (можно override через `rateLimitConfig` в конструкторе) |
| Kline Watchdog (3.5.0) | опциональный `KlineSubscriptionWatchdog` (5-й аргумент конструктора) — обёртывает `subscribeKlines`/`unsubscribeKlines` через Proxy, восстанавливает overdue-подписки |
| Read Retry (3.5.0) | `initialize()` и `updateTickers()` обёрнуты в `withReadRetry()` |
| Аккаунт | `getAccountId()` — первые 16 символов SHA256-хеша API-ключа |

### 4. Интеграции

- **TelegramNotifier** — Telegraf-бот для отправки уведомлений и регистрации команд
- **TelegramCommandHandler<T>** — обработчик команд с типизированными настройками (boolean/numeric)
- **FirebaseServiceBase<T>** — базовый класс Firestore CRUD с real-time подпиской через `onSnapshot()`

### Feeder connection monitoring (общий для приложений-потребителей)

Защита от падения/зависания раздатчика свечей (`@solncebro/market-data-feeder`), общая для volume-breaker, ma-chaser и rubber (раньше дублировалась в каждом):

- **`FeederConnectionGuard`** (`src/core/FeederConnectionGuard.ts`) — реестр замороженных таймфреймов (Set): `markChannelFrozen` / `markChannelRestored` / `isChannelFrozen` / `getFrozenChannelList`, логирует только реальную смену состояния. Приложение консультирует `isChannelFrozen` в своих торговых путях, чтобы не торговать на устаревших данных.
- **`src/utils/feederConnectionMonitor.ts`** — три экспорта: `wireFeederConnectionHandlers` (навешивает `connectionLost`→freeze+alert / `connectionRestored`→unfreeze+alert на ОДИН источник — для приложений с ленивой загрузкой таймфреймов); `runFeederStaleCheck` (один проход watchdog тишины: на каждый НЕ замороженный источник `isStale?.()` → STALE-алерт, без заморозки); `wireFeederConnectionMonitoring` (комбинация для приложений со всеми источниками сразу: обработчики + свой `startIntervalScheduler` на `FEEDER_STALE_WATCHDOG_INTERVAL_MS = 300_000`, возвращает handle для shutdown). Тексты DOWN/RESTORED/STALE параметризованы `appLabel`.
- Решение «что делать при заморозке» (отказать в сделке, бросить ошибку) остаётся в приложении. `MarketDataSource` (`src/core/marketDataSource.types.ts`) дополнен overload'ами `on/off('connectionLost'|'connectionRestored')`.

## Потоки данных

### Создание ордера
```
символ "ETHUSDT"
  → resolveSymbolsForExchanges() → Map<Binance, Map<"ETHUSDT", "ETHUSDT">>
  → createOrderAttributesForSymbol() → OrderAttributes[] с ценой, объёмом, стороной
  → createOrder() → OrderResult { orderId, actualExchangeParams, responseData }
```

### Spot fallback
```
символ "CFGUSDT" (нет на futures)
  → createOrderAttributesForSymbol() → errorText: "No price data available"
  → enrichWithSpotFallback() → marketType переключается на Spot
  → пересчёт цены/объёма по спотовому тикеру
```

### Символы с префиксами (Bybit)
```
"FLOKIUSDT" → resolveSymbolWithPrefix() проверяет:
  FLOKIUSDT → нет
  10FLOKIUSDT → нет
  100FLOKIUSDT → нет
  1000FLOKIUSDT → есть! → возвращает "1000FLOKIUSDT"
```

## Ключевые типы данных

```
SymbolMappingByExchange = Map<ExchangeNameEnum, Map<originalSymbol, resolvedSymbol>>
ExchangeConnectorByName = Map<ExchangeNameEnum, ExchangeConnector>
OrderAttributes = { orderParams, exchangeName, orderVolumeUsdt?, errorText? }
OrderResult = OrderAttributes + { orderId, actualExchangeParams, responseData }
SignalExecutionDetails = OrderResult + { TP, SL, emergencyExit, timings }
```
