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

Интеграционные команды запускаются через скрипт `scripts/runIntegrationJest.js`, который очищает proxy-переменные окружения (`HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/GIT_HTTP_PROXY/GIT_HTTPS_PROXY/SOCKS_PROXY/SOCKS5_PROXY`) и lowercase-варианты (`http_proxy/https_proxy/all_proxy/socks_proxy/socks5_proxy`). Это исключает ситуацию, когда запросы к биржам идут через локальный proxy sandbox и получают `403`.

## Команды

```bash
# Юнит-тесты
yarn test
npx jest tests/utils.test.ts          # один файл

# Живые проверки на демо-счетах
yarn test:integration                  # все
yarn test:integration:binance          # только Binance
yarn test:integration:bybit            # только Bybit
yarn test:integration:okx              # только OKX

# Одиночный интеграционный тест
npx jest --config jest.integration.config.js --runInBand --testPathPatterns=<pattern>
```

Живые проверки **ставят заявки на демо-счёте** примерно на 100 USDT и закрывают их тут же,
в том же тесте — это штатно.

Набора вокруг `OrderCalculator` (`spot-fallback`, `limit-orders`, `multiple-symbols`,
`error-handling`, `e2e-signal`) больше нет: класс уехал из библиотеки в область листингов
(3.13.0) вместе с этими проверками, и восстанавливать их не к чему.

## Граница с exchange-engine

Здесь проверяется ТОЛЬКО обёртка — то, что эта библиотека добавляет поверх нижней: разрешение
имени символа с приставками, кэш тикеров и поведение самого коннектора, потоки `PositionManager`
(чтение позиций, плечо, режим маржи, открытие и закрытие) и `OrderExecutor`.

Договор с биржей — единицы объёма, знаки величин, инварианты ответов, потоки котировок и заявок —
проверяется живыми пробами соседней библиотеки: `../exchange-engine/scripts/` (инструкция —
`README.md` там же; проба OKX — `okx-live-probe`, общая проверка договора — `exchange-live-check`).

Дублировать эти проверки здесь запрещено. Две копии одной правды расходятся, и по расхождению
уже не понять, где ошибка — в обёртке или в договоре с биржей; а живая проверка стоит настоящих
заявок на демо-счёте, и платить за неё дважды незачем.

## Учётные данные для тестов

Файл `.env.test` (не коммитится):
```
BINANCE_DEMO_API_KEY=...
BINANCE_DEMO_SECRET_KEY=...
BYBIT_DEMO_API_KEY=...
BYBIT_DEMO_SECRET_KEY=...
OKX_DEMO_API_KEY=...
OKX_DEMO_SECRET_KEY=...
OKX_DEMO_PASSPHRASE=...
```

Файл читается своим разбором в `testnet.helpers.ts` — `dotenv` в проекте нет, а встроенный
`process.loadEnvFile` внутри Jest пишет в настоящее окружение процесса, тогда как тест видит
подменённую песочницей копию `process.env`.

Ключи создаются на:
- Binance: https://demo.binance.com → Profile → API Management
- Bybit: https://demo.bybit.com → Profile → API Management (ключ привязан к списку разрешённых
  IP: адреса машины нет в списке → биржа отвечает `10010: Unmatched IP` на каждый подписанный
  запрос, публичные при этом проходят)
- OKX: https://www.okx.com → Demo trading → API. **Три** переменные вместо двух: OKX подписывает
  каждый запрос кодовой фразой, заданной при создании ключа. Без `OKX_DEMO_PASSPHRASE` проверки
  считают ключ неполным и пропускают себя. Демо выбирается заголовком `x-simulated-trading: 1`,
  отдельного хоста у OKX нет.

Один ключ на биржу для spot + futures.

## Паттерны интеграционных тестов

### Условный запуск

```typescript
describeIfCredentials(ExchangeNameEnum.Binance, 'Suite Name', () => {
  // автоматически скипается если нет ключей в .env.test
});
```

### Жизненный цикл

```typescript
beforeAll(async () => {
  connector = await createDemoConnector(exchangeName, CONFIG);
  await waitForTickers(connector, TEST_SYMBOL); // ждёт до 30 сек
}, 60000); // таймаут beforeAll

afterAll(async () => {
  await connector.disconnect();
}, 30000);
```

`createDemoConnector` спрашивает у живого счёта его режим позиций
(`futures.fetchPositionMode()`) и собирает коннектор под ответ. Собирать напрямую нельзя:
`futuresPositionMode` задаётся только в конструкторе, а на счёте в режиме «лонг и шорт»
заявка без стороны позиции законно отвергается (OKX отвечает `OKX_POSITION_SIDE_REQUIRED`).
Односторонний режим — значение по умолчанию, поэтому пересборка нужна только двустороннему счёту.

### Паттерн ордера с закрытием

```typescript
// Открытие
const result = await connector.createOrder({
  symbol, side: OrderSideEnum.Buy, amount, price,
  type: OrderTypeEnum.Market, marketType: MarketTypeEnum.Futures,
});
expect(isOrderSuccessful(result)).toBe(true);

// Закрытие обратным ордером
const closeResult = await connector.createOrder({
  symbol, side: OrderSideEnum.Sell, amount, price,
  type: OrderTypeEnum.Market, marketType: MarketTypeEnum.Futures,
  reduceOnly: true,
});
expect(isOrderSuccessful(closeResult)).toBe(true);
```

Тот же круг через высокоуровневый вход — `positionManager.openPositionMarket()` и
`closePositionMarket()`: они сами разбираются со стороной позиции и запретом на увеличение
по бирже и режиму счёта.

### Расчёт тестового объёма

```typescript
const amount = calculateTestAmount(connector, symbol, ticker.lastPrice);
// MIN_TEST_USDT (100) / price, с учётом precision биржи
```

## Тестовые символы

| Биржа | Futures | Что проверяет разрешение символа |
|-------|---------|----------------------------------|
| Binance | ETHUSDT, FLOKIUSDT, SHIBUSDT | приставки `1000FLOKI`, `1000SHIB` |
| Bybit | BTCUSDT, SATSUSDT, FLOKIUSDT, MOGUSDT | приставки `10000SATS`, `1000FLOKI`, `1000000MOG` |
| OKX | ETHUSDT, FLOKIUSDT, SHIBUSDT, SATSUSDT | что символ возвращается **как есть** |

У OKX приставок в названии нет вовсе: один контракт стоит `ctVal` монет, и множитель лежит
отдельным числовым полем инструмента, а не в имени. `FLOKI-USDT-SWAP` (ctVal 100000),
`SHIB-USDT-SWAP`, `SATS-USDT-SWAP` названы без приставок; три инструмента, начинающиеся с
цифры (`0G`, `1INCH`, `2Z`), — настоящие имена монет, а не множители.

## Хелперы (`tests/integration/helpers/`)

### testnet.helpers.ts

- `describeIfCredentials()` — условный describe (для OKX ключ считается полным только с кодовой фразой)
- `createDemoConnector()` — коннектор под настоящий режим позиций счёта (см. «Жизненный цикл»)
- `waitForTickers()` — поллинг тикеров каждую секунду до 30 сек
- `calculateTestAmount()` — расчёт минимального объёма (100 USDT)
- Конфиги: `BINANCE_DEMO_CONFIG`, `BYBIT_DEMO_CONFIG`, `OKX_DEMO_CONFIG`
- Константы: списки символов, `MIN_TEST_USDT = 100`

`signalEmulator.helper.ts` больше нет — он обслуживал проверку `e2e-signal`, снятую вместе
с `OrderCalculator` в 3.13.0.

## Принцип обработки ошибок в тестах

**`createOrder()`** возвращает `errorText` вместо исключения. Проверять через:
- `isOrderSuccessful(result)` — `!!result.orderId`
- `result.errorText` — текст ошибки

**Прямые вызовы клиента** (`connector.futures.*`, `connector.spot.*`) могут бросать исключения — потребитель оборачивает в try/catch:
- `connector.futures.setLeverage()` — throws при невалидном leverage
- `connector.futures.setMarginMode()` — throws при ошибке
- `connector.futures.fetchPosition()` — throws при несуществующем символе, а также на символе
  БЕЗ открытой позиции (Binance записи не держит: `Position not found for ETHUSDT`). Живая
  проверка принимает оба исхода — объект позиции либо этот отказ. Когда важно именно
  «есть или нет», спрашивать `positionManager.readPositionState()`: он отвечает
  `present`/`absent`/`ambiguous` вместо исключения.
