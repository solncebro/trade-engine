# ExchangeConnector — подключение к биржам

Файл: `src/services/exchangeConnector.ts`

## Зависимость

Использует `@solncebro/exchange-engine` (не CCXT напрямую). Все низкоуровневые операции делегируются этой библиотеке.

## Инициализация

```typescript
const connector = new ExchangeConnector(ExchangeName.Binance, {
  apiKey: '...',
  secret: '...',
  demo: true, // demo trading через enableDemoMode
});
await connector.initialize();
// → загружает futures символы, затем spot символы
// → запускает периодическое обновление тикеров (30 сек)
```

## Demo Trading

Включается через `ExchangeConfig.demo = true`. Библиотека `exchange-engine` сама переключает URL:
- **Binance**: `https://demo-api.binance.com` (spot), `https://demo-fapi.binance.com` (futures)
- **Bybit**: `https://api-demo.bybit.com` (REST), `wss://stream-demo.bybit.com/v5/trade` (WebSocket)

**Никаких ручных URL-переопределений.** Не использовать sandbox mode CCXT.

## Тикеры

- Хранятся в `Map<string, Ticker>` с ключом `"marketType:symbol"` (например `"futures:BTCUSDT"`)
- Обновляются каждые 30 секунд через `updateTickers()`
- Получение: `getTicker(symbol, marketType)` → `Ticker | undefined`
- Ticker содержит: `{ close, high, low, percentage, ... }`

## Символы с префиксами

Некоторые биржи (особенно Bybit) используют префиксные символы:
- `1000FLOKIUSDT` вместо `FLOKIUSDT`
- `10000QUBICUSDT` вместо `QUBICUSDT`
- `1000000MOGUSDT` вместо `MOGUSDT`

`resolveSymbolWithPrefix(symbol)` проверяет наличие символа с каждым из префиксов: `[10, 100, 1000, 10000, 100000, 1000000]`.

## Создание ордеров

```typescript
const result = await connector.createOrder({
  symbol: 'BTCUSDT',
  side: OrderSide.Buy,
  amount: 0.001,
  price: 50000,
  type: OrderType.Market,
  marketType: MarketType.Futures,
});
// result: OrderResult { orderId?, errorText?, actualExchangeParams?, responseData? }
```

Особенности по биржам:
- **Bybit**: добавляет `timeInForce`, `triggerPrice`, `triggerDirection`, `stopLossDirection`
- **Futures**: устанавливает `hedgeMode: true`
- **Stop Loss**: добавляет `triggerPrice` и `triggerDirection` (2 = падение для Bybit)

## Публичные методы

| Метод | Возвращает | Описание |
|-------|-----------|----------|
| `initialize()` | `Promise<void>` | Загрузка символов, старт тикеров |
| `resolveSymbolWithPrefix(symbol, marketType?)` | `string` | Поиск символа с префиксом |
| `getTicker(symbol, marketType?)` | `Ticker \| undefined` | Текущий тикер из кэша |
| `createOrder(params)` | `Promise<OrderResult>` | Создание ордера |
| `fetchPosition(symbol)` | `Promise<Position \| null>` | Текущая позиция |
| `setLeverage(symbol, leverage)` | `Promise<boolean>` | Установка кредитного плеча |
| `setMarginMode(symbol, mode)` | `Promise<boolean>` | Установка маржинального режима |
| `getFuturesSymbols()` | `Promise<string[]>` | Список фьючерсных символов |
| `getSpotSymbols()` | `Promise<string[]>` | Список спотовых символов |
| `getClient(marketType?)` | `ExchangeClient` | Низкоуровневый клиент биржи |
| `getExchangeName()` | `ExchangeName` | Имя биржи |
| `getAccountId()` | `string` | SHA256 хеш API-ключа (16 символов) |
| `disconnect()` | `Promise<void>` | Остановка тикеров, закрытие соединения |

## Обработка ошибок

Ошибки торговых операций **не бросают исключения**. Вместо этого:
- `createOrder()` → `OrderResult.errorText`
- `setLeverage()` / `setMarginMode()` → `false`
- `fetchPosition()` → `null`

Это ключевой принцип: код вызывающей стороны проверяет `isOrderSuccessful(result)` или наличие `errorText`.
