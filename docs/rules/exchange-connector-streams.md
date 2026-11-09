# ExchangeConnector — потоки и сторожа подписок

Часть `exchange-connector.md` (см. индекс там). Сторож kline-подписок, обобщённый сторож публичных потоков, стакан.

## Kline Subscription Watchdog (3.5.0)

Опциональный мониторинг kline-подписок для автоматического восстановления потерянных подписок. Активируется через 5-й аргумент конструктора `klineWatchdogConfig?: KlineSubscriptionWatchdogConfig`.

Если включён, методы `subscribeKlines`/`unsubscribeKlines` на `connector.spot`/`connector.futures` оборачиваются Proxy — каждый incoming kline-handler регистрируется в watchdog, который отслеживает timestamp последнего полученного события для пары `(symbol, interval)`.

**Алгоритм восстановления**:
1. Periodic scan каждые `checkIntervalMs` (default 30 сек) — ищет overdue подписки (нет событий дольше `graceMs`).
2. Для всех overdue сразу → отправка уведомления через `onNotify`, одна пакетная команда `resubscribeKlineList` на весь круг (раньше была отдельная команда `resubscribeKlines` на каждую пару символ+таймфрейм — при массовой просрочке это било по лимиту запросов биржи и рвало соединение).
3. Если переподписка не восстановила поток → REST refetch последних `restRefetchLimit` свечей + replay user-handler.
4. Cooldown между восстановлениями: `recoveryCooldownMs` (default 120 сек), `recoveryFailCooldownMs` (default 600 сек после `recoveryFailCountThreshold` неудач).

Диагностика: `KlineSubscriptionWatchdog.getDiagnosticInfo()` → `{ totalSubscriptions, overdueCount, inProgressCount, suppressedCount, tickCount, lastTickTimestamp }`.

См. `src/services/klineSubscriptionWatchdog.ts`.

## Stream Subscription Watchdog (3.6.0)

Обобщённый `StreamSubscriptionWatchdog` (`src/services/streamSubscriptionWatchdog.ts`) — единый, stream-type-agnostic мониторинг здоровья WS-подписок для **не-kline** публичных потоков (orderbook / publicTrade / markPrice). Общее ядро (scan loop, cooldown/fail-escalation, suppression, parallel-batch recovery, heartbeat, notify + структурные события) идентично для всех типов; различия инкапсулированы в `StreamWatchdogStrategy` (`src/services/streamWatchdogStrategies.ts`):

- **`computeAgeMs(entry, now)`** — для orderbook/publicTrade/markPrice это flat heartbeat-age (`now − freshnessTimestamp`); для kline (будущая миграция) — interval-projection.
- **`recover(key)`** — orderbook → `resubscribeOrderbook`; publicTrade → `resubscribePublicTrades`; markPrice → `resubscribeMarkPrices` (resubscribe-only, без REST-replay → `suppressDuringRecovery=false`).

Watchdog handler-агностичен: примитивы `registerKey/recordFreshness/isSuppressed/unregisterKey`. Оборачивание конкретного handler'а (запись freshness + проверка suppression) делает Proxy в `ExchangeConnector.createWatchdogClientProxy` — там же известен тип handler'а. Активируется per-stream через 7-й аргумент конструктора `streamWatchdogConfig` (см. «Инициализация» в [`exchange-connector.md`](exchange-connector.md)), **default OFF**.

**События** (`StreamWatchdogCallbacks`): `onStreamStale` (fires на детекте overdue, до recovery — потребитель может инвалидировать кэш, напр. coin-listing обнуляет bestAsk), `onStreamRecovered`, `onStreamRecoveryFailed`, `onNotify` (Telegram-сводка). ExchangeConnector инъектирует `marketType` в события (watchdog per-marketType).

Диагностика: `StreamSubscriptionWatchdog.getDiagnosticInfo()` → `{ streamType, totalSubscriptions, overdueCount, inProgressCount, suppressedCount, tickCount, lastTickTimestamp }`.

**Клайны переехали (3.22.0).** `KlineWatchdogStrategy` (`src/services/klineWatchdogStrategy.ts`) — стратегия клайнов для того же `StreamSubscriptionWatchdog`: возраст = опоздание клайна, который должен был прийти следом за последним увиденным (`computeAgeMs(entry, now, key)` — интервал берётся по ключу), допуск на интервал (`computeGraceMs`: интервалы из `graceScaledIntervalList` ждут ещё целый интервал), одна пакетная переподписка на всю пачку (`prepareRecoveryBatch` → `resubscribeKlineList`), восстановление ключа — REST-дочитка с таймаутом и реплей в обработчик только клайнов новее последней отметки (`recover(key, context)` читает её из `context.lastEntry`; результат несёт `freshnessTimestamp` последнего REST-клайна и `replayedCount`), сообщения по интервалам с маркером символов (`formatOverdue`/`formatScanResult`). `KlineSubscriptionWatchdog` — тонкая обёртка с прежним интерфейсом: переводит ключи `symbol:interval` в клайновые события и наоборот, сеет свежесть новой подписки открытием идущего интервала (`registerKey(key, ts)`). Двух копий машинерии больше нет.

## Стакан (3.22.0)

Единственная дверь к глубине для потребителя — методы коннектора, не сырой клиент:

- `subscribeOrderBook(symbol, marketType)` / `unsubscribeOrderBook(symbol, marketType)` — со счётчиком ссылок; топик открывается на первой подписке символа, закрывается на последней. Бросает, если у рынка нет потока стакана (Binance spot).
- `getOrderBook(symbol, marketType): LiveOrderBook | null` — живая склеенная книга (числовые уровни, продавцы по возрастанию, покупатели по убыванию, `updateId`, время кадра); `null`, пока не пришёл первый снимок или пока после разрыва нумерации дельт ждём свежий.
- `fetchOrderBook(symbol, marketType, limit?)` — разовое чтение по REST (запасной путь), под `withRetryOn429`.

Внутри — `OrderBookTracker` (`src/services/orderBookTracker.ts`), один на тип рынка, создаётся лениво, подписывается через ПРОКСИРОВАННЫЙ клиент (`getStreamClient`), поэтому сторож стакана, если включён, обёртывает его обработчик. Форматы кадров разные: Binance отдаёт готовый срез (`updateType: 'snapshot'` всегда, глубины 5/10/20) — книга замещается целиком; Bybit отдаёт снимок и дельты (глубины 1/50/200/…) — дельта применяется уровень за уровнем (ноль объёма удаляет уровень); разрыв `updateId` роняет книгу и переподписывает топик с дебаунсом 5 с. Глубина по бирже — `resolveOrderBookStreamDepth` (Binance 20, Bybit 50, **OKX 400** — добавлен в 3.23.0). `disconnect()` снимает все подписки трекера.

**Почему у OKX именно 400.** Промежуточной глубины у него нет вовсе: каналы стакана — 1 уровень (`bbo-tbt`), 5 уровней (`books5`) и 400 (`books`), между пятью и четырьмястами ничего. Пять уровней не отвечают на тот единственный вопрос, ради которого книга и держится, — «сколько влезает в полосу по цене» (`sliceAskVolumeWithinBand`): полоса регулярно достаёт дальше пятого уровня. Поэтому берётся глубокий канал, и число обязано быть ровно 400 — при любом другом запрос всё равно уедет на `books`, только поток предупредит, что запрошенную глубину проигнорировал.

Чистый срез объёма по полосе — `sliceAskVolumeWithinBand` (`src/utils/orderBookSlice.ts`): граница отсчитывается от ОПОРНОЙ цены, не от текущей лучшей; лучшая за границей → `isBeyondBand`. Потребитель-образец — вежливый выход rubber (закрытие кусками по глубине).

`coin-listing` на 28.08.2026 читает стакан в обход (`getClient(marketType).subscribeOrderbook` и своя склейка) — ему адресована строка раздела «Migration» в `CHANGELOG.md`; для записи сырых кадров в базу трекеру понадобится хук «на каждый кадр» (задача библиотеки при переводе coin-listing).
