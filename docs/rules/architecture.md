# Архитектура trade-engine

## Общая схема

```
Сигнал (Telegram/WebSocket)
  → TelegramMessageListener / WebSocket клиент
    → приложение решает символ, объём и сторону (расчёта сигнала в библиотеке нет)
      → ExchangeConnector.resolveSymbolWithPrefix()   имя символа на этой бирже
        → connector.positionManager.*                 деловой вход (открытие/закрытие, SL/TP)
          → ExchangeConnector.createOrder()           единственная дверь на биржу
            → client.createOrderWebSocket()           нижняя библиотека
```

Расчётного слоя сигнала в библиотеке больше нет: статический класс `OrderCalculator` (разбор
символов сигнала, объём, запасной путь через спот, лимитная цена с отступом) удалён в 3.13.0 —
он принадлежал области листингов и уехал туда вместе со своими проверками. Осталась исполняющая
часть, и деловой вход в неё — `connector.positionManager.*` (с 3.4.0): открытие и закрытие, стоп
и тейк без ручной сборки `OrderParams` — см. `positionManager.ts` и `docs/rules/exchange-connector-orders.md`.

Старый путь для наследования — `OrderExecutor`: он же теперь и считает закрывающую заявку.

## Слои

### 1. Транспортный слой (получение сигналов)

- **TelegramMessageListener** — устаревшая обёртка над `createUserClient` из `@solncebro/telegram-engine` (3.24.0), слушает сообщения в каналах. Extends `EventEmitter`, поддерживает множественные обработчики. Новый код — `createUserClient` напрямую.
- **WebSocket** — внешний WS-сервер отправляет `TestMessage` с полями `{sendTime, scrapedTime, sourceTime, source, title, id}`.
- Отдельного standalone-эмулятора `websocketEmulator.utils.ts` в библиотеке больше нет — он принадлежал приложению-потребителю и был удалён; вместе с ним из зависимостей убраны `ws`/`@types/ws`.

### 2. Бизнес-логика (сборка заявки)

Единого «центра вычислений» больше нет — обязанности удалённого `OrderCalculator` разошлись
по трём местам:

| Что было в `OrderCalculator` | Где это теперь |
|------------------------------|----------------|
| `resolveSymbolsForExchanges()` — имена символов с приставками | `ExchangeConnector.resolveSymbolWithPrefix(symbol, marketType)` — по одному символу за вызов, по кэшу тикеров |
| `createOrderAttributesForSymbol()` — цена, объём, сторона, порог 24-часового роста | в библиотеке нет: считает приложение (область листингов) |
| `enrichWithSpotFallback()` — запасной путь через спот | в коде нет вовсе |
| `calculateLimitOrderWithPriceAdjustment()` — лимитная цена с отступом | в коде нет вовсе |
| `calculatePriceLimitBounds()` — ценовые границы биржи | в коде нет вовсе; остались только типы `PriceLimitBoundsArgs` / `PriceLimitBounds` (`src/types/priceLimit.ts`) |
| `calculateCloseOrder()` — закрывающая заявка | `OrderExecutor.buildCloseOrderParams()` (приватный, единственное место применения) |
| `setupLeverageAndMarginModeEnum()` — плечо и режим маржи | `PositionManager.setLeverage()` / `setMarginMode()`, а внутри открытия — `applyFuturesSetup()` |

**PositionManager** (`src/core/positionManager.ts`) — деловой вход. Принимает `symbol`,
`marketType`, `direction`, объём и цену; сам выводит сторону заявки из направления, в двустороннем
режиме счёта — сторону позиции, признак «только уменьшать» (на Binance в этом режиме не ставится:
биржа не принимает его вместе со стороной позиции), при необходимости заранее ставит плечо и режим
маржи. `direction='short'` на споте бросает ошибку сразу, синхронно. Все записи — через очередь
ограничения частоты и повтор на 429.

**OrderExecutor** — базовый класс для наследования (старый путь):
- `createOrder()` — выполнение ордера через ExchangeConnector
- `createCloseOrder()` — TP/SL/аварийный выход (emergency exit → market order)
- `buildCloseOrderParams()` — обратная сторона, цена со сдвигом на процент, у стоп-лосса цена и
  сторона срабатывания, на срочном рынке `reduceOnly`; `positionSide` копируется из исходного
  `orderParams` (нужно для двустороннего режима)

### 3. Коннекторы бирж

**ExchangeConnector** — обёртка над `@solncebro/exchange-engine` `>=0.28.0 <1.0.0` (из реестра npm, диапазон — с 3.21.0, нижняя граница 0.26.0 — с 3.24.0):

| Компонент | Детали |
|-----------|--------|
| Подключение | `initialize()` загружает символы futures + spot (через `withRetryOn429`), запускает тикеры (тоже `withRetryOn429`), разрешает rate limit |
| Тикеры | Кэш `Map<string, Ticker>`, ключ `"marketType:symbol"`, обновление каждые 30 сек |
| Mark price | опционально `startWatchingMarkPrices()` / `getMarkPrice()` / `stopWatchingMarkPrices()` |
| Символы | `resolveSymbolWithPrefix()` проверяет префиксы [10, 100, 1000, 10000, 100000, 1000000] |
| Ордера | `createOrder()` через WebSocket (`createOrderWebSocket`) |
| PositionManager | `positionManager` — lazy-init высокоуровневый API (3.4.0); расширен `modifyOrder/modifyBatchOrders/cancelAllOrders` (3.5.0) |
| Прямой доступ | `spot` / `futures` геттеры → `ExchangeClient` напрямую (с Proxy для kline watchdog, если включён) |
| Rate Limit (3.5.0) | при `initialize()` — `getOrderRateLimit()` → `RateLimitedRequestQueue` для write-операций (можно override через `rateLimitConfig` в конструкторе) |
| Kline Watchdog (3.5.0) | опциональный `KlineSubscriptionWatchdog` (5-й аргумент конструктора) — обёртывает `subscribeKlines`/`unsubscribeKlines` через Proxy, восстанавливает overdue-подписки; с 3.22.0 — обёртка над общим `StreamSubscriptionWatchdog` + `KlineWatchdogStrategy` |
| Стакан (3.22.0) | `subscribeOrderBook`/`getOrderBook`/`unsubscribeOrderBook`/`fetchOrderBook` — единственная дверь к глубине; внутри `OrderBookTracker` |
| Клайны одной монеты (3.27.0) | `subscribeKlines`/`unsubscribeKlines` — подписка на клайны одной монеты через прокси-клиент со сторожем |
| Read Retry (3.5.0) | `initialize()` и `updateTickers()` обёрнуты в `withRetryOn429()` (`withReadRetry` удалён в 3.22.0 — та же функция под вторым именем) |
| Аккаунт | `getAccountId()` — первые 16 символов SHA256-хеша API-ключа |

### 4. Интеграции

- **TelegramNotifier** — бот уведомлений и команд, собранный из деталей `@solncebro/telegram-engine` (3.24.0: весь Telegram пакета — через telegram-engine, прямых импортов `telegraf`/`telegram` нет)
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
символ "ETHUSDT", направление "long", объём и цена от приложения
  → resolveSymbolWithPrefix("ETHUSDT", Futures) → "ETHUSDT"
  → positionManager.openPositionLimit() → OrderParams (сторона, сторона позиции, reduceOnly)
  → connector.createOrder() → buildCreateOrderArgs(): количество и цена на сетке символа,
      срок действия (рыночная — Ioc, прочие — Gtc), triggerPrice → stopPrice
  → client.createOrderWebSocket() → OrderResult { orderId, actualExchangeParams, responseData }
      либо, при отказе, { errorText, errorCode } — исключение наружу не выходит
```

### Закрывающая заявка (старый путь)
```
исходный OrderParams входа + процент сдвига + признак «тейк или стоп»
  → OrderExecutor.buildCloseOrderParams() → обратная сторона, цена со сдвигом,
      у стоп-лосса — triggerPrice и triggerDirection, на срочном рынке — reduceOnly
  → [аварийный выход] тип меняется на рыночный, срабатывание снимается
  → OrderExecutor.createOrder() → CloseOrderResult { orderId, price } либо { errorText }
```

Запасного пути через спот («нет символа на срочном — торгуем на споте») в библиотеке нет: он
удалён вместе с `OrderCalculator` в 3.13.0. Рынок задаёт вызывающий полем `marketType`.

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
