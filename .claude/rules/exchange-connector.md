# ExchangeConnector — подключение к биржам

Файл: `src/services/exchangeConnector.ts`

## Зависимость

Использует `@solncebro/exchange-engine` 0.9.1+ (не CCXT напрямую). Все низкоуровневые операции делегируются этой библиотеке.

## Инициализация

```typescript
const connector = new ExchangeConnector(
  ExchangeNameEnum.Binance,
  { apiKey: '...', secret: '...', isDemoMode: true },
  message => logger.warn(message) // опциональный onNotify callback
);
await connector.initialize();
// → загружает futures символы, затем spot символы
// → запускает периодическое обновление тикеров (30 сек)
```

Третий параметр `onNotify` — опциональный callback для получения критических уведомлений от биржи. Начиная с `exchange-engine` 0.9.0, обработчик CRITICAL-сообщений **не вызывает `process.exit(1)` автоматически** — потребитель должен реализовать собственную логику завершения при необходимости.

## Demo Trading

Включается через `ExchangeConfig.isDemoMode = true`. Библиотека `exchange-engine` сама переключает URL:
- **Binance**: `https://demo-api.binance.com` (spot), `https://demo-fapi.binance.com` (futures)
- **Bybit**: `https://api-demo.bybit.com` (REST), `wss://stream-demo.bybit.com/v5/trade` (WebSocket)

**Никаких ручных URL-переопределений.** Не использовать sandbox mode CCXT.

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
- `createOrderWebSocket(args: CreateOrderWebSocketArgs)` — создание ордера через WebSocket
- `cancelOrder(orderId, symbol)` — отмена ордера
- `getOrder(orderId, symbol)` → `Order` — получение ордера
- `fetchOpenOrders(symbol)` → `Order[]` — открытые ордера
- `fetchOrderHistory(symbol)` → `Order[]` — история ордеров
- `modifyOrder(args: ModifyOrderArgs)` — модификация ордера
- `cancelAllOrders(symbol)` — отмена всех ордеров
- `createBatchOrders(orderList)` — пакетное создание ордеров
- `cancelBatchOrders(orderIdList, symbol)` — пакетная отмена ордеров

**Аккаунт:**
- `fetchFeeRate(symbol)` → `FeeRate` — комиссии
- `fetchIncome(symbol)` → `Income[]` — доходы/расходы
- `fetchClosedPnl(symbol)` → `ClosedPnl[]` — закрытые PnL

**Precision:**
- `amountToPrecision(symbol, amount)` → `string` — округление количества
- `priceToPrecision(symbol, price)` → `string` — округление цены
- `getMinOrderQty(symbol)` → `number` — минимальный объём ордера
- `getMinNotional(symbol)` → `number` — минимальный notional

**WebSocket:**
- `isTradeWebSocketConnected()` → `boolean` — статус WS-соединения
- `connectTradeWebSocket()` — подключение торгового WebSocket
- `getWebSocketConnectionInfoList()` → `WebSocketConnectionInfo[]` — информация о WS-соединениях

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

Особенности `buildCreateOrderArgs`:
- **positionSide**: если явно указан в `orderParams.positionSide`, используется без изменений; для остальных non-Binance бирж автоматически вычисляется (Long для Buy, Short для Sell); Binance Futures игнорирует это поле
- **Futures (кроме Binance)**: если `positionSide` не задан, устанавливает его автоматически (Long для Buy, Short для Sell)
- **Binance Futures**: `positionSide` не передаётся (избегаем конфликта с one-way настройками аккаунта)
- **Market**: поле `price` в `OrderParams` может передаваться для удобства, но для `OrderTypeEnum.Market` оно не форвардится в параметры создания ордера (в том числе для `Binance` market-ордеров)
- **Все биржи**: `timeInForce` — `IOC` для Market, `GTC` для Limit
- **reduceOnly**: если `orderParams.params.reduceOnly = true`
- **Stop Loss**: `triggerPrice` (через `stopPrice`) и `triggerDirection` если указаны в `orderParams`

## Публичные методы

| Метод | Возвращает | Описание |
|-------|-----------|----------|
| `get spot` | `ExchangeClient` | Прямой доступ к spot-клиенту |
| `get futures` | `ExchangeClient` | Прямой доступ к futures-клиенту |
| `initialize()` | `Promise<void>` | Загрузка символов, старт тикеров |
| `resolveSymbolWithPrefix(symbol, marketType)` | `string` | Поиск символа с префиксом |
| `getTicker(symbol, marketType)` | `Ticker \| undefined` | Текущий тикер из кэша |
| `createOrder(params)` | `Promise<OrderResult>` | Создание ордера |
| `getFuturesSymbols()` | `Promise<string[]>` | Список фьючерсных символов |
| `getSpotSymbols()` | `Promise<string[]>` | Список спотовых символов |
| `getClient(marketType)` | `ExchangeClient` | Динамический выбор клиента по marketType |
| `getExchangeName()` | `ExchangeNameEnum` | Имя биржи |
| `getAccountId()` | `string` | SHA256 хеш API-ключа (16 символов) |
| `disconnect()` | `Promise<void>` | Остановка тикеров, закрытие соединения |

## Обработка ошибок

`createOrder()` — единственный метод с внутренним try/catch. Возвращает `OrderResult.errorText` вместо исключения.

Все остальные операции (позиции, баланс, leverage, margin mode, ордерная книга и т.д.) выполняются через `connector.spot` / `connector.futures` напрямую. Обработка ошибок — ответственность потребителя.

Это ключевой принцип: код вызывающей стороны проверяет `isOrderSuccessful(result)` для ордеров или оборачивает прямые вызовы клиента в try/catch.
