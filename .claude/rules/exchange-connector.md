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

Использует `@solncebro/exchange-engine` `>=0.26.0 <1.0.0` (с 3.24.0: субсчета, обрыв и возврат личного потока, ступени плеча; из реестра npm; открытый диапазон вместо точной версии — с 3.21.0, чтобы в дереве потребителя не заводилось второй копии слоя связи). Все низкоуровневые операции делегируются этой библиотеке. **Прямые импорты из `@solncebro/exchange-engine` сторонними потребителями запрещены** — единая точка входа `@solncebro/trade-engine`.

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

Четвёртый параметр `futuresPositionMode` (по умолчанию `PositionModeEnum.OneWay`) задаёт начальный режим для логики `positionSide` при создании **futures**-ордеров; текущее значение читается геттером `connector.futuresPositionMode` (3.24.0). Режим можно сменить во время работы: `PositionManager.setPositionMode({ mode })` переключает его на самой бирже и сразу же после этого — локально (сам вызывает `connector.adoptFuturesPositionMode(mode)`); `connector.adoptFuturesPositionMode(mode)` меняет только локальное значение, без обращения к бирже — им пользуются, когда режим уже известен (например прочитан при запуске через `PositionManager.readPositionMode()`).

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

## Разрешение символа из ввода человека (3.24.0)

`parseRawSymbolInput(raw)` (src/utils/symbol.utils.ts) — «$pepe», «#BTC», «BTC/USDT», «BTCUSDT.P»,
«PEPE/USDT:USDT», «1000PEPE» → `PEPEUSDT` и т. п.; без котировки дописывает USDT, пустой ввод → null.
`normalizeSymbol` — другое: чистит разделители у имени, которое дала биржа.

`resolveFuturesSymbol(raw)` / `resolveSpotSymbol(raw)` → `{ symbol, isFound }` (`ResolvedSymbol`):
1. разбор ввода; 2. `waitForTickersReady(15 с)`; 3. `findSymbolWithPrefix` (как есть, затем 10…1000000 спереди);
4. множитель ПОСЛЕ основы — у Bybit `SHIB1000USDT` (только здесь, `resolveSymbolWithPrefix` так не ищет);
5. `ensureFuturesTradeSymbolLoaded` / `ensureSpotTradeSymbolLoaded` — спецификация, при нужде догрузка.
`findSymbolWithPrefix` — промах = null; `resolveSymbolWithPrefix` — прежний: промах = предупреждение + исходное имя.

## Готовность тикеров (3.24.0)

`initialize()` запускает кэш тикеров без ожидания. `waitForTickersReady(timeoutMs = 30000, marketType = Futures)`
ждёт первый снимок рынка; не бросает, `false` — не дождались (чтение упало, следующий круг через 30 с).

## Коннектор без ключей (3.24.0)

Пустой `apiKey` или `secret` — коннектор только для открытых рыночных данных. На бирже, где таблица ступеней
плеча отдаётся лишь подписанным запросом (Binance), ступени не читаются вовсе (ни в `initialize()`, ни суточным
кругом, ни догрузкой — `ensureFuturesLeverageTierListLoaded` → `false`), одна строка в лог уровня отладки.
Bybit и OKX читают ступени без ключа.

## Общие рыночные данные: главный счёт и субсчета (3.24.0)

`follower.shareMarketDataFrom(primary)` — до `follower.initialize()`, главный инициализирован раньше.
Та же биржа и тот же режим демо/боевой, цепочки запрещены (всё — исключение при вызове).
Ведомый: копирует спецификации инструментов главного в свой клиент (по ним его округление цены и количества),
тикеры читает из карты главного (та же `Map`), ступени плеча и их догрузку отдаёт главному, суточное обновление
и опрос тикеров не запускает. Любая перезагрузка инструментов у главного (суточная, по требованию, вызванная
ведомым) копируется всем ведомым. Своё у каждого: заявки, позиции, баланс, плечо/режим маржи, очередь записи,
личный поток, стакан. `isMarketDataFollower()`. `disconnect()` ведомого снимает его с главного.

## Личный поток счёта (3.24.0)

`getUserDataStreamRouter(marketType = Futures)` — один `UserDataStreamRouter` на рынок коннектора.
Подписать всех (`subscribe({ name, onOrderUpdate, onConnectionLost, onResyncRequired, ... })`), затем один `connect()`.
Прямой `connector.futures.connectUserDataStream` вторым потребителем больше не звать.

## Субсчета (3.24.0)

`connector.subAccounts` — `SubAccountGateway` (ключ главного счёта): список, переводы в обе стороны с номером
вызывающего, состояние перевода, остатки субсчёта; результаты вместо исключений; демо-режим и OKX → `isNotSupported`.
База капитала «главный + субсчета» — `readCapitalBase`. Подробно — `services.md`, раздел «Субсчета».

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
| `get futuresPositionMode` | `PositionModeEnum` | Текущий режим позиций для futures (в конструкторе — начальное значение, по умолчанию `OneWay`; меняется `PositionManager.setPositionMode()` и `adoptFuturesPositionMode()`) (3.24.0) |
| `adoptFuturesPositionMode(mode)` | `void` | Только локально принять режим без обращения к бирже — после того как биржа его уже подтвердила или как он был прочитан (3.24.0) |
| `initialize()` | `Promise<void>` | Загрузка символов, старт тикеров |
| `resolveSymbolWithPrefix(symbol, marketType)` | `string` | Поиск символа с префиксом |
| `findSymbolWithPrefix(symbol, marketType)` | `string \| null` | То же, промах = null (3.24.0) |
| `resolveFuturesSymbol(raw)` / `resolveSpotSymbol(raw)` | `Promise<ResolvedSymbol>` | Ввод человека/сигнала → имя на бирже `{ symbol, isFound }` (3.24.0) |
| `waitForTickersReady(timeoutMs?, marketType?)` | `Promise<boolean>` | Ожидание первого снимка тикеров (3.24.0) |
| `ensureSpotTradeSymbolLoaded(symbol)` | `Promise<boolean>` | Спецификация спотового символа, при нужде догрузка (3.24.0) |
| `getFuturesOrderRules(symbol)` | `FuturesOrderRules \| null` | Сетка цены/объёма и пороги размера заявки (`{ symbol, tickSize, stepSize, minAmount, minNotionalUsd }`) для точки безубыточности с поправкой на комиссию и деления объёма на лоты; `null`, пока спецификация не загружена (`ensureFuturesTradeSymbolLoaded`) (3.24.0) |
| `shareMarketDataFrom(primary)` / `isMarketDataFollower()` | `void` / `boolean` | Общие рыночные данные главного счёта и субсчетов (3.24.0) |
| `getUserDataStreamRouter(marketType?)` | `UserDataStreamRouter` | Один личный поток на рынок (3.24.0) |
| `get subAccounts` | `SubAccountGateway` | Субсчета главного счёта (3.24.0) |
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
