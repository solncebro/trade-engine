# ExchangeConnector — подключение к биржам

Файл: `src/services/exchangeConnector.ts`

## Зависимость

Использует `@solncebro/exchange-engine` 0.5.0+ (не CCXT напрямую). Все низкоуровневые операции делегируются этой библиотеке.

## Инициализация

```typescript
const connector = new ExchangeConnector(ExchangeNameEnum.Binance, {
  apiKey: '...',
  secret: '...',
  isDemoMode: true, // demo trading
});
await connector.initialize();
// → загружает futures символы, затем spot символы
// → запускает периодическое обновление тикеров (30 сек)
```

## Demo Trading

Включается через `ExchangeConfig.isDemoMode = true`. Библиотека `exchange-engine` сама переключает URL:
- **Binance**: `https://demo-api.binance.com` (spot), `https://demo-fapi.binance.com` (futures)
- **Bybit**: `https://api-demo.bybit.com` (REST), `wss://stream-demo.bybit.com/v5/trade` (WebSocket)

**Никаких ручных URL-переопределений.** Не использовать sandbox mode CCXT.

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
- **Futures**: устанавливает `positionSide` (Long для Buy, Short для Sell)
- **Все биржи**: `timeInForce` — `IOC` для Market, `GTC` для Limit
- **reduceOnly**: если `orderParams.params.reduceOnly = true`
- **Stop Loss**: `triggerPrice` (через `stopPrice`) и `triggerDirection` если указаны в `orderParams`

## Публичные методы

| Метод | Возвращает | Описание |
|-------|-----------|----------|
| `initialize()` | `Promise<void>` | Загрузка символов, старт тикеров |
| `resolveSymbolWithPrefix(symbol, marketType)` | `string` | Поиск символа с префиксом |
| `getTicker(symbol, marketType)` | `Ticker \| undefined` | Текущий тикер из кэша |
| `createOrder(params)` | `Promise<OrderResult>` | Создание ордера |
| `fetchPosition(symbol, marketType)` | `Promise<Position \| null>` | Текущая позиция |
| `setLeverage(symbol, leverage)` | `Promise<boolean>` | Установка кредитного плеча (только futures) |
| `setMarginMode(symbol, mode)` | `Promise<boolean>` | Установка маржинального режима (только futures) |
| `getFuturesSymbols()` | `Promise<string[]>` | Список фьючерсных символов |
| `getSpotSymbols()` | `Promise<string[]>` | Список спотовых символов |
| `getClient(marketType)` | `ExchangeClient` | Низкоуровневый клиент биржи |
| `isTradeWebSocketConnected(marketType)` | `boolean` | Статус Trade WebSocket |
| `connectTradeWebSocket(marketType)` | `Promise<void>` | Подключение Trade WebSocket |
| `getExchangeName()` | `ExchangeNameEnum` | Имя биржи |
| `getAccountId()` | `string` | SHA256 хеш API-ключа (16 символов) |
| `getWebSocketConnectionInfoList()` | `WebSocketConnectionInfo[]` | Информация обо всех WS-соединениях |
| `fetchBalance(marketType)` | `Promise<BalanceByAsset \| null>` | Баланс аккаунта |
| `fetchOrderHistory(symbol, marketType, options?)` | `Promise<Order[]>` | История ордеров по символу |
| `getMinOrderQty(symbol, marketType)` | `number` | Минимальный объём ордера |
| `getMinNotional(symbol, marketType)` | `number` | Минимальный notional ордера |
| `fetchPositionMode()` | `Promise<PositionModeEnum \| null>` | Режим позиций (Hedge/OneWay) |
| `disconnect()` | `Promise<void>` | Остановка тикеров, закрытие соединения |

## Обработка ошибок

Ошибки торговых операций **не бросают исключения**. Вместо этого:
- `createOrder()` → `OrderResult.errorText`
- `setLeverage()` / `setMarginMode()` → `false`
- `fetchPosition()` → `null`
- `fetchBalance()` → `null`
- `fetchPositionMode()` → `null`
- `fetchOrderHistory()` → `[]`
- `getWebSocketConnectionInfoList()` → `[]`
- `getMinOrderQty()` / `getMinNotional()` → `0`

Это ключевой принцип: код вызывающей стороны проверяет `isOrderSuccessful(result)` или наличие `errorText`.
