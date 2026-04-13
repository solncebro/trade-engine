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

## Слои

### 1. Транспортный слой (получение сигналов)

- **TelegramMessageListener** — MTProto-клиент (`telegram` lib), слушает сообщения в каналах. Extends `EventEmitter`, поддерживает множественные обработчики.
- **WebSocket** — внешний WS-сервер отправляет `TestMessage` с полями `{sendTime, scrapedTime, sourceTime, source, title, id}`.
- **WebSocketEmulator** (`src/utils/websocketEmulator.utils.ts`) — standalone CLI-скрипт для ручного тестирования. Не импортируется в коде — для тестов используется `SignalEmulatorServer` из хелперов.

### 2. Бизнес-логика (расчёт ордеров)

**OrderCalculator** — статический класс, центр вычислений:

| Метод | Назначение |
|-------|-----------|
| `resolveSymbolsForExchanges()` | Маппинг символов → биржевые форматы (с учётом префиксов 1000FLOKI и т.д.) |
| `createOrderAttributesForSymbol()` | Расчёт параметров ордера: цена, объём, сторона, проверка 24h% роста |
| `enrichWithSpotFallback()` | Замена ошибок "No price data" на спот-ордера |
| `calculateLimitOrderWithPriceAdjustment()` | Корректировка цены лимитного ордера на процент |
| `calculateCloseOrder()` | Создание TP/SL ордеров с `reduceOnly` и `triggerPrice` |
| `setupLeverageAndMarginModeEnum()` | Установка кредитного плеча и маржинального режима |
| `getUniqueSymbolCountFromMapping()` | Подсчёт уникальных символов для распределения объёма |

**OrderExecutor** — базовый класс для наследования:
- `createOrder()` — выполнение ордера через ExchangeConnector
- `createCloseOrder()` — TP/SL/аварийный выход (emergency exit → market order)

### 3. Коннекторы бирж

**ExchangeConnector** — обёртка над `@solncebro/exchange-engine` 0.9.1+:

| Компонент | Детали |
|-----------|--------|
| Подключение | `initialize()` загружает символы futures + spot, запускает тикеры |
| Тикеры | Кэш `Map<string, Ticker>`, ключ `"marketType:symbol"`, обновление каждые 30 сек |
| Символы | `resolveSymbolWithPrefix()` проверяет префиксы [10, 100, 1000, 10000, 100000, 1000000] |
| Ордера | `createOrder()` через WebSocket (`createOrderWebSocket`) |
| Прямой доступ | `spot` / `futures` геттеры → `ExchangeClient` напрямую |
| Аккаунт | `getAccountId()` — первые 16 символов SHA256-хеша API-ключа |

### 4. Интеграции

- **TelegramNotifier** — Telegraf-бот для отправки уведомлений и регистрации команд
- **TelegramCommandHandler<T>** — обработчик команд с типизированными настройками (boolean/numeric)
- **FirebaseServiceBase<T>** — базовый класс Firestore CRUD с real-time подпиской через `onSnapshot()`

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
