# Тестирование

## Конфигурации Jest

**Юнит-тесты** (`jest.config.js`):
- Корни: `src/`, `tests/`
- Игнорирует: `tests/integration/`
- Покрытие: `src/**/*.ts`

**Интеграционные тесты** (`jest.integration.config.js`):
- Корень: `tests/integration/`
- Таймаут: 180 секунд
- Всегда запускать с `--runInBand` (последовательно)

**Jest 30**: использовать `--testPathPatterns` (множественное число), не `--testPathPattern`.

## Команды

```bash
# Юнит-тесты
yarn test
npx jest tests/utils.test.ts          # один файл

# Интеграционные тесты
yarn test:integration                  # все
yarn test:integration:binance          # только Binance
yarn test:integration:bybit            # только Bybit
yarn test:integration:e2e-signal       # E2E сигнал→ордер
yarn test:integration:spot-fallback    # спот-фолбэк
yarn test:integration:limit-orders     # лимитные ордера
yarn test:integration:multiple-symbols # мульти-символы
yarn test:integration:error-handling   # обработка ошибок
yarn test:integration:mvp              # комплексный набор

# Одиночный интеграционный тест
npx jest --config jest.integration.config.js --runInBand --testPathPatterns=<pattern>
```

## Учётные данные для тестов

Файл `.env.test` (не коммитится):
```
BINANCE_DEMO_API_KEY=...
BINANCE_DEMO_SECRET_KEY=...
BYBIT_DEMO_API_KEY=...
BYBIT_DEMO_SECRET_KEY=...
```

Ключи создаются на:
- Binance: https://demo.binance.com → Profile → API Management
- Bybit: https://demo.bybit.com → Profile → API Management

Один ключ на биржу для spot + futures.

## Паттерны интеграционных тестов

### Условный запуск

```typescript
describeIfCredentials(ExchangeName.Binance, 'Suite Name', () => {
  // автоматически скипается если нет ключей в .env.test
});
```

### Жизненный цикл

```typescript
beforeAll(async () => {
  connector = new ExchangeConnector(exchangeName, CONFIG);
  await connector.initialize();
  await waitForTickers(connector, TEST_SYMBOL); // ждёт до 30 сек
}, 60000); // таймаут beforeAll

afterAll(async () => {
  await connector.disconnect();
}, 30000);
```

### Паттерн ордера с закрытием

```typescript
// Открытие
const result = await connector.createOrder({
  symbol, side: OrderSide.Buy, amount, price,
  type: OrderType.Market, marketType: MarketType.Futures,
});
expect(isOrderSuccessful(result)).toBe(true);

// Закрытие обратным ордером
const closeResult = await connector.createOrder({
  symbol, side: OrderSide.Sell, amount, price,
  type: OrderType.Market, marketType: MarketType.Futures,
});
expect(isOrderSuccessful(closeResult)).toBe(true);
```

### Расчёт тестового объёма

```typescript
const amount = calculateTestAmount(connector, symbol, ticker.close);
// MIN_TEST_USDT (100) / price, с учётом precision биржи
```

## Тестовые символы

| Биржа | Futures | Spot Fallback |
|-------|---------|---------------|
| Binance | ETHUSDT, FLOKIUSDT, SHIBUSDT | CFGUSDT |
| Bybit | BTCUSDT, 10000QUBICUSDT, FLOKIUSDT, MOGUSDT | CFGUSDT |

**CFGUSDT** — символ, который есть только на споте. Используется для тестирования fallback.

## Хелперы (`tests/integration/helpers/`)

### testnet.helpers.ts

- `describeIfCredentials()` — условный describe
- `waitForTickers()` — поллинг тикеров каждую секунду до 30 сек
- `calculateTestAmount()` — расчёт минимального объёма (100 USDT)
- `serializeMapping()` — сериализация Map для логирования
- Конфиги: `BINANCE_DEMO_CONFIG`, `BYBIT_DEMO_CONFIG`
- Константы: списки символов, `MIN_TEST_USDT = 100`

### signalEmulator.helper.ts

- **SignalEmulatorServer** — WS-сервер на порту 0 (OS-assigned)
  - `start()` → порт, `stop()`, `sendSignal()`, `waitForConnection()`
- **connectClient(port)** — подключение WS-клиента с ожиданием `open`
- **waitForMessage(client)** — промис на первое сообщение (таймаут 5 сек)
- **parseSymbolFromSignalTitle(title)** — извлечение символа:
  1. Прямое совпадение: `/([A-Z0-9]+USDT)\b/`
  2. Из скобок: `/\(([A-Z0-9]+)\)/` → добавляет `USDT`

## Принцип обработки ошибок в тестах

Торговые ошибки **не бросают исключения**. Проверять через:
- `isOrderSuccessful(result)` — `!!result.orderId`
- `result.errorText` — текст ошибки
- `setLeverage()` / `setMarginMode()` → `boolean`
- `fetchPosition()` → `null` при ошибке
