# ExchangeConnector — подключение к биржам

Файл: `src/services/exchangeConnector.ts`

## Детальная документация

Файл разросся за 30 000 знаков и разделён по теме (09.09.2026) — все четыре читать как один документ:

| Файл | О чём |
|---|---|
| `exchange-connector.md` (этот файл) | зависимость, инициализация, demo trading, прямой доступ к клиентам, mark price, тикеры, символы с префиксами, публичные методы коннектора, ограничение частоты записи, повтор чтений, обработка ошибок |
| [exchange-connector-client-api.md](exchange-connector-client-api.md) | полный справочник методов `ExchangeClient` (`connector.spot` / `connector.futures`) |
| [exchange-connector-orders.md](exchange-connector-orders.md) | создание ордеров (`buildCreateOrderArgs`), чем OKX отличается от Binance и Bybit, методы `PositionManager` |
| [exchange-connector-streams.md](exchange-connector-streams.md) | `KlineSubscriptionWatchdog`, обобщённый `StreamSubscriptionWatchdog`, стакан (`OrderBookTracker`) |

## Зависимость

Использует `@solncebro/exchange-engine` `>=0.22.0 <1.0.0` (из реестра npm; открытый диапазон вместо точной версии — с 3.21.0, чтобы в дереве потребителя не заводилось второй копии слоя связи). Все низкоуровневые операции делегируются этой библиотеке. **Прямые импорты из `@solncebro/exchange-engine` сторонними потребителями запрещены** — единая точка входа `@solncebro/trade-engine`.

Начиная с exchange-engine 0.22.1 он объявляет `@solncebro/websocket-engine` `>=0.6.0 <1.0.0` одолженной (peer) зависимостью и собственной копии канала не заводит — trade-engine поэтому тоже объявляет `@solncebro/websocket-engine` прямой зависимостью (не импортирует его сам), чтобы в процессе потребителя канал всегда был ровно один.

## Инициализация

```typescript
import { ExchangeNameEnum, PositionModeEnum } from '@solncebro/trade-engine';

const connector = new ExchangeConnector(
  ExchangeNameEnum.Binance,
  { apiKey: '...', secret: '...', isDemoMode: true },
  message => logger.warn(message),
  PositionModeEnum.Hedge,
  klineWatchdogConfig,   // 5-й — опционально (3.5.0)
  rateLimitConfig,       // 6-й — опционально (3.5.0)
  streamWatchdogConfig,  // 7-й — опционально (3.6.0): orderbook/publicTrade/markPrice watchdog
  tradeSymbolsRefreshConfig // 8-й — опционально: { tradeSymbolsRefreshIntervalMs } (сутки; 0 — выключить)
);
await connector.initialize();
// → loadTradeSymbols (futures + spot) обёрнут в withRetryOn429
// → getOrderRateLimit() → создаётся RateLimitedRequestQueue (если rateLimitConfig не null)
// → installPriceTickSnapper() (3.17.0) — подключает formatPrice/snapPriceToTick к тиковой сетке символов
// → fetchTickers через withRetryOn429, периодическое обновление каждые 30 сек
// → klineWatchdog запускается (если включён)
// → заводится суточное обновление инструментов: ближайшие 00:05 UTC + случайный сдвиг 0–120 сек
```

Третий параметр `onNotify` — опциональный callback для получения критических уведомлений от биржи. Начиная с `exchange-engine` 0.9.0, обработчик CRITICAL-сообщений **не вызывает `process.exit(1)` автоматически** — потребитель должен реализовать собственную логику завершения при необходимости.

Четвёртый параметр `futuresPositionMode` (по умолчанию `PositionModeEnum.OneWay`) задаёт режим для логики `positionSide` при создании **futures**-ордеров; значение доступно как публичное поле `connector.futuresPositionMode`.

**Пятый параметр `klineWatchdogConfig`** (3.5.0, опционально, `KlineSubscriptionWatchdogConfig`) — настройки `KlineSubscriptionWatchdog`. Если задан, методы `subscribeKlines`/`unsubscribeKlines` оборачиваются Proxy для отслеживания timestamp каждой подписки. Default: `isEnabled: true`. См. `src/services/klineSubscriptionWatchdog.ts`.

**Шестой параметр `rateLimitConfig`** (3.5.0, опционально, `RateLimitConfig | null`):
- `null` — не использовать rate limit вообще.
- `{ writeRequestsPerSecond, intervalMs? }` — статически переопределить.
- `undefined` (default) — динамически читать с биржи через `getOrderRateLimit()` в `initialize()`.

**Седьмой параметр `streamWatchdogConfig`** (3.6.0, опционально, `StreamWatchdogConfigMap`) — per-stream настройки `StreamSubscriptionWatchdog` для **не-kline** публичных потоков: `{ orderbook?, publicTrade?, markPrice? }`, каждый — `StreamWatchdogStreamConfig` (`isEnabled` + grace/cooldown + callbacks `onStale/onRecovered/onRecoveryFailed/onNotify`, вызываемые с инъекцией `marketType`). **Все три по умолчанию OFF** (`isEnabled` нужно явно выставить `true`) — публикация ничего не меняет, пока потребитель не включит. При `isEnabled=true` соответствующие `subscribe*/unsubscribe*` оборачиваются Proxy (обёрнутый handler-ref трекается по watchdog-key, не по handler — корректный unsubscribe при shared handler ref). `markPrice` доступен только на futures (Bybit). `startWatchingMarkPrices` маршрутизируется через проксированный `this.futures`, чтобы markPrice-watchdog видел внутренний handler. Каждый стрим-тип — собственный `StreamSubscriptionWatchdog` с per-stream стратегией (`OrderbookWatchdogStrategy` и т.д., `src/services/streamWatchdogStrategies.ts`): heartbeat-staleness + resubscribe-recovery (orderbook/publicTrade/markPrice). См. раздел `StreamSubscriptionWatchdog` в [`exchange-connector-streams.md`](exchange-connector-streams.md).

## Demo Trading

Включается через `ExchangeConfig.isDemoMode = true`. Библиотека `exchange-engine` сама переключает URL:
- **Binance**: `https://demo-api.binance.com` (spot), `https://demo-fapi.binance.com` (futures)
- **Bybit**: `https://api-demo.bybit.com` (REST), `wss://stream-demo.bybit.com/v5/trade` (WebSocket)
- **OKX**: хост тот же (`https://www.okx.com`), демо выбирается заголовком `x-simulated-trading: 1`; поток — `wss://wspap.okx.com:8443/ws/v5/…`

**Никаких ручных URL-переопределений.**

У OKX в `ExchangeConfig` заполняется ещё и `passphrase` — кодовая фраза, заданная при создании ключа: биржа подписывает ею каждый запрос, и без неё ключ не работает вовсе.

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

### Полный справочник методов ExchangeClient — в отдельном файле

Перечень всех методов, доступных через `connector.spot` / `connector.futures`, вынесен в [`exchange-connector-client-api.md`](exchange-connector-client-api.md) (см. таблицу «Детальная документация» вверху).

## Mark Price (real-time)

`ExchangeConnector` поддерживает подписку на real-time обновления mark price через WebSocket:

```typescript
connector.startWatchingMarkPrices(); // подписка (idempotent)
connector.getMarkPrice('BTCUSDT');   // → MarkPriceUpdate | undefined
connector.stopWatchingMarkPrices();  // отписка + очистка кэша
```

- Данные хранятся в `Map<symbol, MarkPriceUpdate>` — обновляются при каждом WebSocket-событии
- Фильтрует невалидные значения (`markPrice <= 0` или не-finite)
- `disconnect()` автоматически вызывает `stopWatchingMarkPrices()`
- Использует `exchange.futures.subscribeMarkPrices` / `unsubscribeMarkPrices` из `exchange-engine` 0.13.0+

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

**У OKX приставок нет вовсе.** Множитель там — отдельное числовое поле контракта (`ctVal`, сколько монет в одном контракте), а не часть имени: `FLOKI-USDT-SWAP` при `ctVal` 100000 всё равно называется `FLOKIUSDT`. Инструменты, чьё имя начинается с цифры (`0G`, `1INCH`, `2Z`), — настоящие названия монет. Поэтому на OKX `resolveSymbolWithPrefix` возвращает символ как есть, а перевод монет в контракты и обратно спрятан в `exchange-engine` (наружу `amount` всегда в монетах — и в заявке, и в `amountToPrecision`, который у бессрочных контрактов округляет ВНИЗ до целого числа контрактов, а не к ближайшему шагу).

Имена символов OKX не проходят через `normalizeSymbol` (в отличие от Bybit): `exchange-engine` уже склеивает части идентификатора инструмента в обычное имя (`BTC-USDT-SWAP` → `BTCUSDT`), разделителей в нём не бывает.

## Заявки и позиции — в отдельном файле

Создание ордеров, отличия OKX и методы `PositionManager` вынесены в [`exchange-connector-orders.md`](exchange-connector-orders.md) (см. таблицу «Детальная документация» вверху).

**Восьмой параметр `tradeSymbolsRefreshConfig`** (опционально, `TradeSymbolsRefreshConfig`) — расписание встроенного обновления инструментов: `{ tradeSymbolsRefreshIntervalMs? }`, умолчание — 24 часа, `0` (или меньше) выключает таймер совсем. Подробности — раздел «Суточное обновление инструментов» ниже.

## Суточное обновление инструментов

Инструменты грузятся один раз, в `initialize()`. Процесс, живущий неделями, без обновления не узнаёт ни об одной монете, вышедшей на биржу после его запуска, — а у спота перезагрузки не было вовсе. Поэтому после успешного `initialize()` коннектор заводит собственный таймер:

- **Момент — ближайшие 00:05 по всемирному времени**, сразу за суточной границей свечей и ежедневными отчётами приложений; дальше тот же момент каждые сутки. Он пересчитывается от часов перед каждым кругом, поэтому случайный сдвиг не уводит расписание.
- **Случайный сдвиг 0–120 секунд** — чтобы несколько процессов на одном адресе не пришли к бирже в одно мгновение (предел запросов). Сдвиг добавляется только к суточному расписанию; заданный вручную другой интервал берётся как есть.
- **Один запрос списка инструментов на рынок в сутки** — против любого предела частоты это ничто. Оба рынка обновляются **последовательно** (срочный, затем спот), а не одновременно; сама перезагрузка идёт через `withRetryOn429`, как и при запуске.
- **Следующий круг заводится только после того, как предыдущий закончился** — наложения двух кругов не бывает; отдельный сторож (`isRefreshingAllTradeSymbols`) отвергает и внешний вызов, пришедший посреди круга.
- Таймер **не держит процесс живым** (`unref`), снимается в `disconnect()` и переставляется при повторном `initialize()`.
- Отказ рынка **глотается с предупреждением в журнал** — устаревший список лучше пустого, и второй рынок обновляется независимо от судьбы первого.

Тот же круг руками — `refreshAllTradeSymbols(reasonLabel?)`. Однополётный промис и откат в 60 секунд (`TRADE_SYMBOLS_RELOAD_COOLDOWN_MS`) теперь ведутся **по каждому рынку отдельно**, поэтому спотовая перезагрузка не мешает фьючерсной и наоборот. Сторож — `tests/exchangeConnectorTradeSymbolsSchedule.test.ts`.

## Публичные методы

| Метод / поле | Возвращает | Описание |
|-------|-----------|----------|
| `get spot` | `ExchangeClient` | Прямой доступ к spot-клиенту |
| `get futures` | `ExchangeClient` | Прямой доступ к futures-клиенту |
| `get positionManager` | `PositionManager` | Lazy-init высокоуровневый API ордеров и позиций (3.4.0) |
| `futuresPositionMode` | `PositionModeEnum` | Режим позиций для futures (задаётся в конструкторе, по умолчанию `OneWay`) |
| `initialize()` | `Promise<void>` | Загрузка символов, старт тикеров |
| `resolveSymbolWithPrefix(symbol, marketType)` | `string` | Поиск символа с префиксом |
| `getTicker(symbol, marketType)` | `Ticker \| undefined` | Текущий тикер из кэша |
| `startWatchingMarkPrices()` | `void` | Подписка на real-time mark price (idempotent) |
| `stopWatchingMarkPrices()` | `void` | Отписка и очистка кэша mark price |
| `getMarkPrice(symbol)` | `MarkPriceUpdate \| undefined` | Последний mark price из кэша |
| `createOrder(params)` | `Promise<OrderResult>` | Создание ордера |
| `createBatchOrders(orderParamsList)` | `Promise<OrderResult[]>` | Пакетное создание ордеров; каждый элемент несёт `orderId` при успехе или `errorText` с реальным ответом биржи при отказе (не угадывается по номеру заявки, 3.16.0) |
| `getFuturesSymbols({ excludeTradifi? })` | `Promise<string[]>` | Список фьючерсных символов; `excludeTradifi: true` отсеивает токенизированные TradFi-перпы (акции/ETF/сырьё) по нормализованному `TradeSymbol.isTradifi` (Binance `contractType: TRADIFI_PERPETUAL`, Bybit `symbolType: stock/commodity`; exchange-engine ≥ 0.18.0) |
| `getSpotSymbols()` | `Promise<string[]>` | Список спотовых символов |
| `refreshFuturesTradeSymbols()` | `Promise<void>` | Перезагрузка списка фьючерсных инструментов (однополётная, с откатом 60 сек; отказ глотается) |
| `refreshAllTradeSymbols(reasonLabel?)` | `Promise<void>` | Перезагрузка обоих рынков подряд — то же, что делает суточный таймер; отказ каждого рынка глотается с предупреждением |
| `getClient(marketType)` | `ExchangeClient` | **Raw** клиент по marketType (без watchdog-прокси) |
| `getStreamClient(marketType)` | `ExchangeClient` | **Проксированный** клиент по marketType (3.6.0): stream-консьюмеры подписываются через него, чтобы `StreamSubscriptionWatchdog` оборачивал их handler'ы |
| `getExchangeName()` | `ExchangeNameEnum` | Имя биржи |
| `getAccountId()` | `string` | SHA256 хеш API-ключа (16 символов) |
| `disconnect()` | `Promise<void>` | Остановка тикеров, mark price, суточного обновления инструментов, закрытие соединения |

## Rate Limiting (3.5.0)

`ExchangeConnector` при `initialize()` опрашивает `getOrderRateLimit()` и создаёт `RateLimitedRequestQueue` с лимитом RPS из биржевого ответа. Эта очередь применяется ко всем write-операциям `PositionManager` (создание/отмена/модификация ордеров, setLeverage/setMarginMode).

**Параметр конструктора `rateLimitConfig`**:
- `null` — не использовать rate limit вообще (очередь не создаётся).
- `{ writeRequestsPerSecond: 10, intervalMs: 1000 }` — статически переопределить (не запрашивать у биржи).
- `undefined` (default) — динамически читать с биржи в `initialize()`.

В случае ошибки `getOrderRateLimit()` используется fallback (15 RPS, source: `'fallback'`).

См. `src/core/RateLimitedRequestQueue.ts`.

## Потоки и сторожа подписок — в отдельном файле

Сторож kline-подписок, обобщённый `StreamSubscriptionWatchdog` и стакан вынесены в [`exchange-connector-streams.md`](exchange-connector-streams.md) (см. таблицу «Детальная документация» вверху).

## Read Retry (3.5.0)

В `initialize()` и `updateTickers()` вызовы `loadTradeSymbols` / `fetchTickers` (и `fetchOrderBook`) обёрнуты в `withRetryOn429()` — retry с exponential backoff на сетевых ошибках и 429/5xx. См. `src/core/withRetryOn429.ts`. Отдельного `withReadRetry` больше нет (3.22.0): он был той же функцией под вторым именем.

## Обработка ошибок

`createOrder()` — единственный метод с внутренним try/catch. Возвращает `OrderResult.errorText` вместо исключения. Если ошибка является `ExchangeError`, то `OrderResult.errorCode` заполняется кодом ошибки биржи.

Все остальные операции (позиции, баланс, leverage, margin mode, ордерная книга и т.д.) выполняются через `connector.spot` / `connector.futures` напрямую. Обработка ошибок — ответственность потребителя.

Это ключевой принцип: код вызывающей стороны проверяет `isOrderSuccessful(result)` для ордеров или оборачивает прямые вызовы клиента в try/catch.
