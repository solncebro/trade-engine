# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.14.0] - 2026-08-04

### Added

- **Модуль определения тренда (`TrendCalculator` + `TrendMonitor`)** — определяет направление (рост/падение/боковик) и численную силу (0–100) тренда актива по закрытым свечам методом структуры рынка (вершины и впадины, метод Доу). `TrendCalculator` — статический расчёт: поиск вершин/впадин зигзагом с адаптивным от волатильности порогом (`computePivotList`); вердикт по последним точкам с досрочным сломом тренда по закрытию за уровнем последней противоположной точки (`assessTrend`); сила из трёх составляющих (согласованность шагов, крутизна, мелкость откатов). `TrendMonitor` — живой наблюдатель поверх источников свечей: держит вердикт по каждому интервалу отдельно и сводку по всем, шлёт событие `trendChanged` только при фактической смене направления по закрытой свече, чисто снимает подписки. `formatTrendSummaryMessage` — готовый текст сводки для Telegram. Модуль ничего не торгует, не отправляет сам и не ходит на биржу — только отвечает и оповещает. (`src/core/trendCalculator.ts`, `src/core/TrendMonitor.ts`, `src/telegram/trendMessageTemplates.ts`, `.claude/rules/trend.md`)

  Доработки по итогам ревью на реальных данных: (1) множитель порога по умолчанию `1.618` (был 2 — слишком грубо, «замораживал» структуру на сильных движениях); (2) потолок порога `maxReversalPercent` (20%) — одна вертикальная свеча с огромным истинным размахом больше не раздувает ATR настолько, что реальный откат после неё перестаёт считаться разворотом; (3) слом тренда проверяется по **всей** истории после впадины/вершины, а не только по последней свече; (4) новые поля `TrendAssessment.trendStartIndex`/`trendEndIndex` — границы текущей структурной ноги (самый недавний монотонный отрезок higher-high+higher-low, ломающая точка в него не входит; считается и при `flat`), чтобы нумеровать точки от реального начала тренда, а не от края данных; `isYoungAfterBreak` (тренд стартовал сразу после структурного слома — сила ×0.5); (5) соседние точки гарантированно на разных свечах; (6) потолок порога `maxReversalPercent` (20%) против раздувания ATR одной вертикальной свечой; (7) множитель порога по умолчанию `1.618`.

- **`KlineSubscriptionWatchdogConfig.graceScaledIntervalList`** — список таймфреймов, для которых запас просрочки масштабируется длиной свечи: порог = `openTimestamp + intervalMs + (intervalMs + graceMs)`, то есть тревога только после пропуска ДВУХ свечей подряд. Для таймфреймов вне списка формула прежняя (`openTimestamp + intervalMs + graceMs`); по умолчанию список пуст, поэтому поведение существующих потребителей не меняется. (`src/services/klineSubscriptionWatchdog.ts`, `klineSubscriptionWatchdog.types.ts`)

  Повод — постоянные ложные тревоги «Kline subscriptions overdue … 5m — Lag 184s» по единичным неликвидным символам в kliner. Сторож считает свежесть по времени ОТКРЫТИЯ последней полученной свечи, а по неликвидному символу внутри 5-минутки может не прийти ни одного обновления: самым свежим остаётся открытие предыдущей свечи, и при запасе (180с) меньше длины свечи (300с) тревога срабатывала гарантированно, стоило первым трём минутам новой свечи пройти без сделок. Каждая такая ложная тревога тянула за собой переподписку и REST-рефетч истории. Замер по бирже (сутки минутных свечей): паузы без сделок до 3–11 минут по разным символам, у части монет встречаются пятиминутки вовсе без сделок.

### Fixed

- **Зеркало журнала в Google-таблице: числа записываются числами, а не текстом.** Корень обоих дефектов (даты показывались голым числом вместо даты; в ячейке виднелся весь хвост двоичной арифметики) — зеркало формировало КАЖДУЮ ячейку строкой, а `valueInputOption: USER_ENTERED` разбирает такую строку по языку САМОЙ таблицы. У боевых таблиц rubber язык `ru_RU` (десятичный разделитель — запятая), поэтому «46233.04166666667» числом не признавалось и ячейка молча становилась текстовой: оформление «дата-время» к тексту неприменимо, а текст показывает ровно то, что в нём лежит. Проверено чтением ячейки боевой таблицы: `userEnteredValue.stringValue`. Теперь числовые значения уходят числами, остальное — текстом; сравнение «лист против базы» приводит обе стороны к тексту, поэтому строки не переписываются вхолостую. (`src/services/tradeJournal/sheetsSync.ts`)

- **Числа в таблице без мусорного хвоста двоичной арифметики.** Проценты уходят в лист делением на 100, и −2,83 давало −0,028300000000000002. Значения приводятся к 15 значащим цифрам — хвост исчезает, настоящие длинные числа (средневзвешенная цена входа вида 0,00619640833333333) сохраняются полностью, и значение переживает цикл «запись → чтение» без изменений. (`src/services/tradeJournal/sheetsSync.ts`)

- **Оформление даты переставляется после каждой дописки строк** и после полной перезаписи листа, а не только при подключении: строка, добавленная вставкой (`insertDataOption: INSERT_ROWS`), оформление колонки не наследует. Значение даты остаётся дробным — по документации Google целая часть числа это дни с 30.12.1899, дробная — время суток, поэтому округлять его до целого нельзя (потерялось бы время сделки). (`src/services/tradeJournal/sheetsSync.ts`)

### Changed

- **Upgraded `@solncebro/exchange-engine` from 0.18.0 to 0.18.3.** Тянет три исправления вверх по цепочке: (1) 0.18.1 — `cancelBatchOrders` на Binance Futures не работал ни разу с момента появления метода (биржа отвергала весь запрос из-за неверной сериализации `orderIdList`); (2) 0.18.2 — `fetchIncome` принимает `incomeType: 'funding'` для полного списка фандинг-платежей без потери записей на лимите страницы; (3) 0.18.3 — `normalizeBinancePosition` больше не бросает `NaN` в `leverage`, если Binance не прислал это поле. Обратная совместимость полная — новые поля опциональны, публичный контракт `cancelBatchOrders` не изменился.

## [3.13.0] - 2026-07-20

### Added

- **Реэкспорт `TriggerByEnum`** из exchange-engine — приложениям нужен явный выбор цены срабатывания условных заявок (`LastPrice`/`MarkPrice`/`IndexPrice`) без прямого импорта exchange-engine (он запрещён при использовании trade-engine). Повод — инцидент ESPORTSUSDT 19.07.2026: молчаливое умолчание `MarkPrice` в `placeConditional` сработало аварийный стоп rubber по всплеску цены маркировки (спот-индекс шёл на 10–14% выше фьючерса), которого последняя цена сделки не достигала; rubber теперь передаёт `LastPrice` явно. Само умолчание `MarkPrice` НЕ изменено — существующие приложения (volume-breaker) ведут себя как раньше, переход каждого — осознанным явным параметром. (`src/index.ts`)

- **`TradifiSymbolGate` — opt-in допуск TradFi** через новый булев аргумент конструктора `shouldAllowTradifi?: boolean` (по умолчанию `false`). По умолчанию поведение не меняется: токенизированные акции/ETF/сырьё остаются отфильтрованы. Только если приложение-потребитель явно передаёт `shouldAllowTradifi: true`, фильтр снимается — универс грузится с `excludeTradifi: false`, и TradFi-символы становятся разрешёнными (`isAllowed`/`classify`/`filterSymbolList`). (`src/services/tradifiSymbolGate.ts`, `tradifiSymbolGate.types.ts`)

### Changed

- **Надёжность прогона тестов/сборки** — все фоновые служебные таймеры библиотеки помечены `.unref()` (kline/stream watchdog, обновление тикеров, флаш журнала, alarm PnL, планировщик интервалов). Такой таймер больше не удерживает процесс Node от завершения в одиночку; в проде поведение не меняется (петлю событий держат живые сокеты/сервер), а Jest перестал ругаться на «worker process failed to exit gracefully». (`klineSubscriptionWatchdog.ts`, `streamSubscriptionWatchdog.ts`, `exchangeConnector.ts`, `tradeJournal/persistentTradeJournal.ts`, `GenericPnlMonitor.ts`, `utils/intervalScheduler.ts`)
- **Требование к среде выполнения — Node.js >= 22.0.0** (`engines.node` в `package.json`, было `>=18`). Приведено к версии `@solncebro/exchange-engine`.
- **Тесты `persistentTradeJournal` и `sheetsSync` перенесены** из `src/services/tradeJournal/` в `tests/` — в соответствие с конвенцией размещения тестов; относительные импорты обновлены. Поведение и покрытие не изменились.

### Removed

- **Удалён standalone-эмулятор `src/utils/websocketEmulator.utils.ts`** — мёртвый код: нигде не импортировался, не реэкспортировался из barrel и не был в скриптах. Рабочая копия эмулятора живёт в приложении-потребителе (`coin-listing`). Вместе с ним из зависимостей убраны `ws` и `@types/ws` (их единственным потребителем был этот файл).
- **Удалена зависимость `dotenv`** — осиротела после удаления эмулятора (был её единственным потребителем); в рабочем коде библиотеки не используется.

## [3.12.0] - 2026-07-15

### Added

- **`TradifiSymbolGate`** — переиспользуемый хранитель «универса без TradFi»: загружает список фьючерсов без токенизированных акций/сырья (`getFuturesSymbols({ excludeTradifi: true })`), отвечает `isAllowed(symbol)`, классифицирует незнакомый символ через `classify(symbol)` (одна общая перезагрузка кэша символов на всех одновременных новичков — кулдаун соединителя бережёт REST; отрицательный вердикт помнится час, чтобы акция, льющая клайны каждые полчаса, не долбила биржу перезагрузками), `loadUniverse()`/`reloadUniverse()` для стартовой загрузки и часовой синхронизации листингов. Потребители: market-data-feeder (универс фида) и rubber (собственный фильтр входящего фида — вторая линия защиты, чтобы не верить составу фида слепо). Появился после инцидента 15.07.2026: фидер на проде не был перезапущен после фикса 3.11.0, и rubber всю сессию торговал акциями (SNDK/SOXL/SNXX) — теперь приложение-приёмник отбрасывает их само. (`src/services/tradifiSymbolGate.ts`)

- **`splitOrderQty({ rebalanceTail })`** — новая опция канонического дробителя объёма: когда остаточный хвост меньше minQty, последний кусок ужимается так, чтобы хвост дорос до minQty, вместо молчаливого отбрасывания. Хвост округляется по шагу ВВЕРХ, ужатый кусок — ВНИЗ (сумма кусков никогда не превышает исходный объём — критично для reduce-only заявок); невыполнимо (ужатый кусок упал бы ниже minQty) — прежнее поведение с отбрасыванием, вызывающий видит недостачу по сумме кусков. Нужна защитным и закрывающим заявкам: отброшенный хвост стопа = вечно незакрываемая пыль позиции (инцидент BLASTUSDT 15.07.2026: биржевой потолок рыночной заявки молча урезал стоп 53.4М контрактов до 43М, остаток повис без защиты). (`src/utils/sizeOrder.ts`)

### Fixed

- **`splitOrderQty`: фантомный остаток из плавающей запятой больше не рождает пылевой кусок.** Разность вида `192.34 − 167` оставляет в машинной арифметике остаток ~4e-15; добор хвоста принимал его за настоящий недобор, округлял вверх до целого шага и ужимал предыдущий кусок — стоп SOXLUSDT вставал как `[167, 25.33, 0.01]` вместо `[167, 25.34]` (сумма верная, но лишняя пылинка 0.01 в стакане). Остаток меньше одного шага количества теперь считается нулём — он всё равно непредставим в заявке. (`src/utils/sizeOrder.ts`)

### Changed

- **`ExchangeConnector.createOrder`/`createBatchOrders` логируют запрос и успех** (символ, сторона, тип, объём, цена, триггер, reduceOnly, clientOrderId; при успехе — orderId). До этого постановка заявок не оставляла в логах приложений НИКАКИХ следов (логировались только ошибки) — при инциденте BLASTUSDT невозможно было доказать, какой объём реально ушёл на биржу. Теперь молчаливое урезание объёма биржей видно как расхождение «запрошено vs принято». (`src/services/exchangeConnector.ts`)

## [3.11.0] - 2026-07-15

### Changed

- **`getFuturesSymbols({ excludeTradifi })` фильтрует по нормализованному `TradeSymbol.isTradifi`** (exchange-engine ≥ 0.18.0) вместо Binance-специфичного `contractType === 'TRADIFI_PERPETUAL'`. Закрывает дыру: Bybit листит токенизированные акции/ETF (96 шт. на 15.07.2026, первые с 21.04.2026, включая IBMUSDT) и сырьё (нефть BZ/CL, золото, серебро) с обычным `contractType: 'LinearPerpetual'` — прежний фильтр их пропускал в фид и детекцию стратегий (замечен триггер по IBMUSDT в rubber). Маркер Bybit — поле `symbolType: 'stock'`/`'commodity'`, которое exchange-engine 0.18.0 нормализует в `isTradifi`; `symbolType: 'innovation'` — обычная крипта, не отсеивается. Примечание записи 3.6.0 «Безопасно для Bybit — там такого contractType нет» было неверно уже на момент написания (22.06.2026): акции на Bybit торговались с 21.04.2026, просто помечены другим полем. (`src/services/exchangeConnector.ts`)

## [3.10.0] - 2026-07-13

### Added

- **`PersistentTradeJournal`** (`src/services/tradeJournal/`) — переиспользуемый буферизованный журнал сделок: владеет клиентами Supabase и Google Sheets, копит сводки сделок и события в памяти и сливает их пачками (по умолчанию каждые 3с), возвращая несохранённое в очередь при сбое БД — ничего не теряется. Зеркалит сводки в Google-таблицу (живой слив с антидребезгом и/или периодическая пересинхронизация из Supabase, плюс полная пересинхронизация `fullSyncToSheet`), восстанавливает сводки в память после рестарта (`rehydrateSummaries`), помечает брошенные (`markOrphaned`), немедленно досливает терминальную запись (`flushSummaryNow`), хранит операционное состояние бумажных позиций (`savePaperState`/`loadPaperStateList`/`removePaperState`) и даёт обобщённый доступ к произвольной доп. таблице (`insertRow`/`updateRows`/`selectRows`). Проект-потребитель описывает только структуру своих таблиц (`TradeJournalSchema`) и вызывает `putSummary`/`patchSummary`/`enqueueEvent` — транспорт, очередь и антидребезг скрыты в библиотеке. Новые зависимости: `@supabase/supabase-js`, `@googleapis/sheets`. (`src/services/tradeJournal/persistentTradeJournal.ts`, `sheetsSync.ts`)

## [3.9.0] - 2026-07-03

### Added

- **`ExchangeConnector.refreshFuturesTradeSymbols()`** — публичное обновление кэша фьючерсных инструментов из биржи. `getFuturesSymbols()` читает кэш, который иначе заполняется один раз в `initialize()`, поэтому периодическая сверка листингов/делистингов (например, часовая сверка market-data-feeder) обязана сначала вызывать этот метод — без него сверка сравнивает кэшированный список сам с собой и никогда не видит изменений. Делит single-flight-перезагрузку и кулдаун (60с) с on-demand-перезагрузкой спецификации символа (`ensureFuturesTradeSymbolLoaded`); неудачная перезагрузка логируется и глотается — вызывающий сохраняет прежний кэш (устаревший лучше пустого). (`src/services/exchangeConnector.ts`)

## [3.6.0] - 2026-06-22

### Added

- **`ExchangeConnector.getFuturesSymbols({ excludeTradifi })`** — необязательный фильтр, исключающий Binance `TRADIFI_PERPETUAL` (токенизированные акции) из списка фьючерсных символов; остаются только обычные крипто-перпы (`PERPETUAL`). Бэк-совместимо: без аргумента поведение прежнее. Безопасно для Bybit — там такого `contractType` нет. (`src/services/exchangeConnector.ts`)

## [3.5.0] - 2026-05-17

### Added

**Reliability-инфраструктура**:
- **`RateLimitedRequestQueue`** (`src/core/RateLimitedRequestQueue.ts`) — sliding-window очередь для write-операций с заданным RPS. Args: `{ rateLimit, intervalMs?, loggerLabel? }`. Логирует первый throttle.
- **`withRetryOn429`** и **`withReadRetry`** (`src/core/withRetryOn429.ts`) — функциональные retry-обёртки на 429/5xx с exponential backoff и поддержкой `Retry-After`. Args: `{ fn, contextLabel, maxRetries?, baseDelayMs? }`.
- **`KlineSubscriptionWatchdog`** (`src/services/klineSubscriptionWatchdog.ts`) — мониторинг и автоматическое восстановление потерянных kline-подписок. Periodic scan → resubscribe → REST refetch + replay user handler. API диагностики `getDiagnosticInfo()`.

**ExchangeConnector**:
- 5-й и 6-й аргументы конструктора: `klineWatchdogConfig?: KlineSubscriptionWatchdogConfig` (опциональный мониторинг) и `rateLimitConfig?: RateLimitConfig | null` (override rate limit).
- При `initialize()` динамически опрашивает `getOrderRateLimit()` и создаёт `RateLimitedRequestQueue` для write-операций (используется через `PositionManager`).
- `loadTradeSymbols` и `fetchTickers` теперь обёрнуты в `withReadRetry`.
- Геттеры `spot` и `futures` возвращают Proxy с watchdog-обёрткой `subscribeKlines`/`unsubscribeKlines` (если watchdog включён).

**PositionManager** (расширения 3.5.0):
- **`cancelAllOrders(args: CancelAllOrdersArgs)`** — высокоуровневая обёртка над `client.cancelAllOrders(symbol)` с queue+retry.
- **`cancelBatchOrders(args)`** теперь возвращает `Promise<CancelBatchOrdersResult>` (per-order результаты `{ orderId, isSuccess, errorCode, errorText }`).
- **`modifyOrder(args: PositionManagerModifyOrderArgs)`** — высокоуровневая модификация одного ордера (price/amount/triggerPrice).
- **`modifyBatchOrders(args: PositionManagerModifyBatchOrdersArgs)`** — массовая модификация ордеров (Binance Futures REST chunk=5, Bybit linear=20 / spot=10; Bybit через WS если подключён). На Binance Spot бросает `Not supported for spot market`.
- Все write-операции (open/close/cancel/modify/setLeverage/setMarginMode) теперь идут через `withRetryOn429` и write-очередь.
- Constructor принимает опциональный `queue?: RateLimitedRequestQueue`. Если не передан, очередь берётся у `ExchangeConnector` (`getWriteQueue()`) **на каждый вызов** — гарантирует актуальный RPS из `initialize()` (раньше очередь фиксировалась при первом обращении к `positionManager` и могла навсегда остаться на fallback).

**FirebaseServiceBase**:
- `updateData(data)` теперь корректно обрабатывает вложенные объекты через внутреннюю утилиту `flattenForFirestoreUpdate()` — превращает `{ a: { b: 1 } }` в `{ "a.b": 1 }` (dot-notation, как требует Firestore `documentReference.update()`).

**Type re-exports** (из `@solncebro/exchange-engine` 0.14.0):
- `CancelBatchOrdersResult`, `CancelOrderItemResult`
- `OrderRateLimit`, `OrderRateLimitSource`
- `ModifyBatchOrderArgs`, `ModifyBatchOrdersResult`, `ModifyOrderItemResult`
- `MarkPriceHandler`, `PriceLimitRisk`, `LeverageFilter`, `TradingFunding`
- `BalanceUpdateEvent`, `BalanceUpdateItem`, `BalanceUpdateHandler` (commit `d93c52a` — Binance Spot user-data через WebSocket API; событие `outboundAccountPosition → onBalanceUpdate`)

**Export из entry** (`src/index.ts`) — новые типы PositionManager: `PositionManagerModifyOrderArgs`, `PositionManagerModifyBatchOrdersArgs`, `PositionManagerModifyBatchOrderItem`, `CancelAllOrdersArgs`. Также: `RateLimitedRequestQueue` + `RateLimitedRequestQueueArgs`, `KlineSubscriptionWatchdog` + `KlineSubscriptionWatchdog*` типы, `withRetryOn429`, `withReadRetry` + `WithRetryOn429Args`, `WithReadRetryArgs`, `RateLimitConfig`.

### Changed

- **Upgraded `@solncebro/exchange-engine` from 0.13.0 to 0.14.0** (commit `d93c52a` — Binance Spot user-data перестроен на WebSocket API; установлено локально через `"file:../exchange-engine"`; не из npm registry — версия копится для будущей публикации).
- `ExchangeClient.cancelBatchOrders` теперь возвращает `Promise<CancelBatchOrdersResult>` (`CancelOrderItemResult[]`) вместо `Promise<void>` (BREAKING в exchange-engine 0.14.0; миграция не требуется для consumers, игнорирующих возврат).
- **Принцип единой точки входа**: класс `Exchange` (factory) и утилита `formatWebSocketConnectionsReport` из `@solncebro/exchange-engine` НЕ реэкспортируются — внешние приложения работают только через `@solncebro/trade-engine`.

### Fixed (релиз-ревью 3.5.0)

- **`KlineSubscriptionWatchdog.stop()`** очищает все внутренние коллекции (`subscribedHandlerByKey`, `subscribedIntervalByKey`, `lastKlineByKey`, `recoveryStateByKey`, `suppressedKeySet`) — ранее `subscribedHandlerByKey`/`subscribedIntervalByKey`/`lastKlineByKey` оставались, и после `stop()`+`start()` старые подписки сразу считались overdue и реплеились в устаревшие хендлеры.
- **`PositionManager`** больше не фиксирует write-очередь при первом обращении: берёт её у `ExchangeConnector.getWriteQueue()` на каждый вызов, поэтому write-операции, выполненные до завершения `initialize()`, после него используют актуальный RPS (раньше могли навсегда остаться на fallback).
- **`withRetryOn429`** учитывает заголовок `Retry-After` не только на `429`, но и на `5xx` (биржевые maintenance-окна отдают `Retry-After` на `503`) — раньше на `5xx` всегда применялся exponential backoff.
- **`ExchangeConnector`** пропускает тик `updateTickers`, если предыдущий ещё не завершился (защита от наложения параллельных обновлений при медленном `withReadRetry`).
- **`RateLimitedRequestQueue`** логирует throttling по скользящему окну (60s) вместо одного раза за весь процесс — восстановлена наблюдаемость повторных эпизодов троттлинга.

### Notes on exchange-engine 0.14.0 (commit `d93c52a`)

- `ExchangeClient.getOrderRateLimit()` → `Promise<OrderRateLimit>` — per-UID write RPS (Binance: парсится из `/exchangeInfo` rateLimits; Bybit: hardcoded 20 RPS из документации V5; fallback 15 RPS).
- Bybit V5 publicTrade/orderbook подписки (`subscribeOrderbook`, `subscribePublicTrades`) — Binance бросает `Not supported`.
- Типы `OrderBookUpdate`, `OrderBookHandler`, `PublicTradeHandler`, `SubscribeOrderbookArgs`, `SubscribePublicTradesArgs`.
- `ExchangeClient.awaitWebSocketConnectionsReady()` — дождаться готовности WS после subscribe (Binance Futures multi-connection).
- `ExchangeClient.modifyBatchOrders(orderList)` → `Promise<ModifyBatchOrdersResult>` — REST для всех бирж + WS для Bybit. Binance Futures chunk=5, Bybit linear=20 / spot=10. На Binance Spot — `Not supported`. Типы `ModifyBatchOrderArgs`, `ModifyOrderItemResult`, `ModifyBatchOrdersResult`.
- BREAKING: тип возврата `cancelBatchOrders` (см. Changed выше).
- Commit `d93c52a` поверх релиза 0.14.0: Binance Spot user-data перестроен на WebSocket API (listenKey REST удалён биржей 2026-02-20); новый класс `BinanceSpotUserDataStream`, типы `BalanceUpdateEvent`/`BalanceUpdateItem`/`BalanceUpdateHandler`, опциональный `UserDataStreamHandlerArgs.onBalanceUpdate`.

См. полный changelog: `/Users/sol/dev/solncebro/exchange-engine/CHANGELOG.md`.

## [3.4.0] - 2026-04-30

### Added
- **`PositionManager`** (`src/core/positionManager.ts`) — высокоуровневый API поверх `ExchangeConnector`: открытие/закрытие позиций (limit и market), `placeStopLoss` / `placeTakeProfit`, `cancelOrder` / `cancelBatchOrders`, `spotMarketBuyByQuote`, `setLeverage`, `setMarginMode`. Скрывает от приложений детали вроде `positionSide`, `reduceOnly`, `workingType`, `triggerBy`, `orderFilter`, `marketUnit` и различия Binance/Bybit; вход — бизнес-аргументы (`symbol`, `marketType`, `direction`, `amount`, `price` / `triggerPrice`). На spot при `direction='short'` — синхронный `Error`
- **`ExchangeConnector.positionManager`** — геттер с lazy-init экземпляра `PositionManager`
- Экспорт из entry (`src/index.ts`): `PositionManager` и типы аргументов `Direction`, `StopOrderType`, `OpenPositionLimitArgs`, `OpenPositionMarketArgs`, `ClosePositionLimitArgs`, `ClosePositionMarketArgs`, `PlaceStopLossArgs`, `PlaceTakeProfitArgs`, `CancelOrderArgs`, `CancelBatchOrdersArgs`, `SpotMarketBuyByQuoteArgs`, `SetLeverageArgs`, `SetMarginModeArgs`
- **`OrderParams`**: опциональные `triggerBy`, `workingType`, `reduceOnly` (top-level), `closeOnTrigger`, `closePosition`, `orderFilter`, `marketUnit`, `trailingDelta`, `quoteOrderQty`, `clientOrderId`
- Реэкспорт из `@solncebro/exchange-engine` через `src/types/index.ts`: `MarketUnitEnum`, `OrderFilterEnum`, `TriggerByEnum`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.12.1 to **0.13.0** (в т.ч. `OrderTypeEnum.StopLimit` / `TakeProfitLimit`, расширение `CreateOrderWebSocketArgs`, отчёт по WebSocket-соединениям, `fetchPositionMode` для Bybit и др. — см. changelog `exchange-engine`)
- **`ExchangeConnector.buildCreateOrderArgs()`**: раздельная сборка для spot и futures; на spot не уходят futures-only поля; на futures пробрасываются новые поля; `reduceOnly` учитывается и из top-level `OrderParams.reduceOnly`, и из `params.reduceOnly`; в Hedge при отсутствии `positionSide` выполняется вывод по `(side, reduceOnly)` с записью предупреждения в лог (для явного контракта рекомендуется `PositionManager`)

### Fixed
- **`OrderCalculator.calculateCloseOrder()`** переносит `positionSide` из исходного `orderParams` в параметры close-ордера (корректная работа в Hedge)
- Top-level **`OrderParams.reduceOnly`** больше не игнорируется при сборке аргументов ордера

## [3.3.1] - 2026-04-24

### Added
- `ExchangeConnector`: четвёртый опциональный аргумент конструктора `futuresPositionMode` (по умолчанию `PositionModeEnum.OneWay`) и публичное поле `readonly futuresPositionMode` — режим для логики `positionSide` при создании futures-ордеров

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.12.0 to 0.12.1
- `ExchangeConnector.buildCreateOrderArgs()`: в режиме **Hedge** при отсутствии явного `orderParams.positionSide` автоматически выставляется `Long` / `Short` по стороне ордера; в режиме **OneWay** (по умолчанию) `positionSide` автоматически не подставляется

### Fixed
- Явный реэкспорт типа `MarkPriceUpdate` из публичного entry (`src/types/index.ts`)

## [3.3.0] - 2026-04-24

### Added
- `ExchangeConnector.startWatchingMarkPrices()` — подписка на real-time обновления mark price через WebSocket
- `ExchangeConnector.stopWatchingMarkPrices()` — отписка и очистка кэша mark price
- `ExchangeConnector.getMarkPrice(symbol)` — получение последнего mark price из кэша (`MarkPriceUpdate | undefined`)
- `OrderCalculator.calculatePriceLimitBounds(args)` — расчёт ценовых лимитов (min/max) для символа с учётом exchange-specific правил (Bybit `bybitRiskParameters`, Binance `multiplierUp/Down`)
- Новые типы: `PriceLimitBounds`, `PriceLimitBoundsArgs` (реэкспортируются из `src/types/priceLimit.ts`)
- `EntityWithErrorText.errorCode?: number | string` — числовой или строковый код ошибки биржи (заполняется из `ExchangeError.code` при ошибке создания ордера)
- `OrderResult.attemptCount?: number` — количество попыток создания ордера
- Новый реэкспорт из `@solncebro/exchange-engine`: `MarkPriceUpdate`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.11.0 to 0.12.0
- `ExchangeConnector.disconnect()` теперь вызывает `stopWatchingMarkPrices()` при отключении

### Notes on exchange-engine 0.12.0
- `ExchangeClient` interface: новые методы подписки на mark price — `subscribeMarkPrices(handler)`, `unsubscribeMarkPrices(handler)`
- `MarkPriceUpdate` — нормализованное событие обновления mark price (symbol, markPrice, indexPrice?, timestamp)

## [3.2.0] - 2026-04-17

### Added
- New type re-exports from `@solncebro/exchange-engine`: `OrderUpdateEvent`, `PositionUpdateEvent`, `OrderUpdateHandler`, `PositionUpdateHandler`, `UserDataStreamHandlerArgs`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.10.0 to 0.11.0

### Notes on exchange-engine 0.11.0
- `ExchangeClient` interface: новые методы User Data Stream — `connectUserDataStream(handler)`, `disconnectUserDataStream()`, `isUserDataStreamConnected()`
- `OrderUpdateEvent` — нормализованное событие обновления ордера (symbol, orderId, side, status, price, avgPrice, amount, filledAmount, timestamp)
- `PositionUpdateEvent` — нормализованное событие обновления позиции (symbol, side, size, entryPrice, markPrice, unrealisedPnl, leverage, liquidationPrice, positionSide, timestamp)

## [3.1.5] - 2026-04-14

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.9.1 to 0.10.0

### Notes on exchange-engine 0.10.0
- `BybitLinear.setMarginMode()` is now a no-op — Bybit manages margin mode at account level, not per-symbol
- `BybitPublicStream`: improved multi-connection support with automatic topic chunking (max 200 topics per connection) and batched subscribe messages (max 10 topics per SUBSCRIBE request)
- `BybitBaseClient.getOrder()`: now checks realtime (open orders) first, then falls back to order history
- `BybitBaseClient.submitOrder()`: now checks `isConnected()` before sending via WebSocket
- `BybitLinear.setLeverage()`: improved error handling for error code 110043 (leverage not modified)
- `normalizeBybitKlines()`: fixed kline sorting order (now ascending chronological)

## [3.1.4] - 2026-04-13

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.7.1 to 0.9.1

### Notes on exchange-engine 0.8.0–0.9.1
- `ExchangeClient.resubscribeKlines(symbol, interval)` — new method for explicit WebSocket stream reconnection
- `TradeSymbol.contractType: string` — new field identifying contract type (PERPETUAL, TRADIFI_PERPETUAL, etc.)
- `BaseExchangeClient.createNotifyHandler()` no longer calls `process.exit(1)` after CRITICAL messages — consumers must implement their own shutdown logic if needed
- `BaseHttpClient` non-GET HTTP errors now throw readable `Error` messages instead of raw `AxiosError`

## [3.1.3] - 2026-04-08

### Added
- `OrderParams`: new optional `positionSide?: PositionSideEnum` field — allows explicit control of position side when creating futures orders

### Changed
- `ExchangeConnector.buildCreateOrderArgs()`: now respects explicit `positionSide` in `orderParams`, falling back to automatic resolution (`Long` for Buy, `Short` for Sell) only on non-Binance exchanges and when not explicitly set

## [3.1.2] - 2026-04-01

### Added
- `ExchangeConnector` constructor: new optional `onNotify` parameter — when provided, passes the callback to `exchange-engine` for handling critical exchange notifications
- New type re-exports from `@solncebro/exchange-engine`: `ExchangeArgs`, `ExchangeLogger`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.6.3 to 0.7.1

## [3.0.2] - 2026-03-31

### Added
- `OrderCalculator.calculateLimitOrderWithPriceAdjustment()`: new optional `exchangeClient` parameter — when provided, applies `amountToPrecision` and `priceToPrecision` to the resulting `amount` and `price`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.6.2 to 0.6.3

## [3.0.1] - 2026-03-26

### Fixed
- `createLogger()` now normalizes `BETTERSTACK_ENDPOINT` before passing it to `@logtail/pino`:
  - trims leading/trailing spaces
  - keeps endpoint unchanged when it already starts with `http://` or `https://`
  - prepends `https://` when only host is provided

## [3.0.0] - 2026-03-24

### Breaking Changes
- **ExchangeConnector**: removed wrapper methods — consumers now use `connector.spot.*` / `connector.futures.*` directly:
  - Removed: `fetchPosition()`, `setLeverage()`, `setMarginMode()`, `isTradeWebSocketConnected()`, `connectTradeWebSocket()`, `getWebSocketConnectionInfoList()`, `fetchBalance()`, `fetchOrderHistory()`, `getMinOrderQty()`, `getMinNotional()`, `fetchPositionMode()`
  - These methods no longer swallow errors internally — callers handle exceptions via try/catch
- **ExchangeConnector.resolveSymbolWithPrefix()**: now requires `marketType` parameter — `resolveSymbolWithPrefix(symbol, marketType)`
- **OrderCalculator.calculateLimitOrderWithPriceAdjustment()**: changed from positional parameters to a single `CalculateLimitOrderWithPriceAdjustmentArgs` object
- Removed re-exports: `normalizeBinanceKlineWebSocketMessage`, `normalizeBybitKlineWebSocketMessage`
- Removed raw type re-exports: `BinanceContinuousKlineMessageRaw`, `BinanceWebSocketKlineRaw`, `BybitKlineMessageRaw`, `BybitPublicTradeDataRaw`, `BybitTradeMessageRaw`, `BybitWebSocketKlineRaw`, `BybitWebSocketMessageRaw`

### Added
- `ExchangeConnector.spot` / `ExchangeConnector.futures` getters for direct `ExchangeClient` access
- New type re-exports from `@solncebro/exchange-engine`: `AccountBalances`, `ClosedPnl`, `CreateOrderWebSocketArgs`, `FeeRate`, `FetchAllKlinesOptions`, `Income`, `MarkPrice`, `ModifyOrderArgs`, `OpenInterest`, `OrderBook`, `OrderBookLevel`, `PublicTrade`, `TradeSymbol`, `TradeSymbolBySymbol`, `TradeSymbolFilter`, `WebSocketConnectionInfo`

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.4.0 to 0.6.0
- `OrderCalculator.setupLeverageAndMarginModeEnum()` now calls `connector.futures.setLeverage()` / `connector.futures.setMarginMode()` directly
- Documentation and project rules synced with v3 API: direct `connector.spot` / `connector.futures` usage and updated error-handling contract
- `yarn build` now runs `yarn lint` before tests and `tsc`; `prepublishOnly` delegates to `yarn build` (lint is not duplicated)

### Fixed
- Integration test runner now strips proxy environment variables to avoid `403` when the execution environment injects a local proxy.
- `ExchangeConnector.createOrder()` fixes for Binance demo flows:
  - For `OrderTypeEnum.Market`, `price` is not forwarded to the exchange order-creation params.
  - For Binance futures, `positionSide` is not sent to avoid conflicts with one-way position settings.

## [2.2.0] - 2026-03-14

### Changed
- `ExchangeConnector.buildCreateOrderArgs()`: applies `amountToPrecision` and `priceToPrecision` to `amount` and `price` before sending to exchange client
- `OrderCalculator.createOrderAttributesForMarketType()`: removed `parseFloat()` wrapper around `amountToPrecision` (now returns `number`)
- Removed redundant `parseFloat()` from `stopPrice` in `buildCreateOrderArgs`
- Upgraded `@solncebro/exchange-engine` from 0.3.3 to 0.4.0

## [2.1.1] - 2026-03-14

### Changed
- `createLogger`: added pino error serializer via `pino.stdSerializers.wrapErrorSerializer` that preserves `code` and `exchange` fields on serialized errors
- Upgraded `@solncebro/exchange-engine` from 0.3.2 to 0.3.3

## [2.1.0] - 2026-03-13

### Changed
- `ExchangeConnector`: 5 методов получили опциональный `marketType?` для универсальной работы со spot и futures:
  - `fetchPosition(symbol, marketType?)`
  - `setLeverage(symbol, leverage, marketType?)`
  - `setMarginMode(symbol, marginMode, marketType?)`
  - `isTradeWebSocketConnected(marketType?)`
  - `connectTradeWebSocket(marketType?)`
- `OrderCalculator.setupLeverageAndMarginModeEnum()`: явный `MarketType.Futures` для самодокументируемости
- Upgraded `@solncebro/exchange-engine` from 0.3.1 to 0.3.2

## [2.0.0] - 2026-03-12

### Breaking Changes
- All re-exported enums renamed with `Enum` suffix to match `@solncebro/exchange-engine` 0.3.0:
  - `ExchangeName` -> `ExchangeNameEnum`
  - `OrderSide` -> `OrderSideEnum`
  - `OrderType` -> `OrderTypeEnum`
  - `MarginMode` -> `MarginModeEnum`
  - `TradeSymbolType` -> `TradeSymbolTypeEnum`
  - `TimeInForce` -> `TimeInForceEnum`
- Ticker property changes (from `exchange-engine` 0.3.0):
  - `ticker.close` -> `ticker.lastPrice`
  - `ticker.percentage` -> `ticker.priceChangePercent`
- `ExchangeConnector.createOrder()` now uses typed `CreateOrderWebSocketArgs` instead of `params: Record<string, unknown>`:
  - `hedgeMode: true` replaced with `positionSide: PositionSideEnum.Long/Short`
  - `timeInForce` uses `TimeInForceEnum` values
  - `triggerPrice` in params replaced with `stopPrice` field
  - `reduceOnly` is now a direct field

### Changed
- Upgraded `@solncebro/exchange-engine` from 0.2.0 to 0.3.0
- Added `sideEffects: false` to package.json for tree-shaking
- Added `declarationMap` for better IDE navigation
- Added lint check to `prepublishOnly` pipeline
- Updated `.npmignore` with comprehensive exclusions
- README.md fully rewritten with actual API examples

### Fixed
- Unused imports removed from integration tests
- ESLint config: jest config files excluded from linting

## [1.2.0] - 2026-03-10

### Added
- Signal emulator test infrastructure (`SignalEmulatorServer`, `connectClient`, `waitForMessage`)
- AI structure file for codebase documentation

### Changed
- Migrated from CCXT to `@solncebro/exchange-engine` 0.2.0
- All exchange operations now use `exchange-engine` unified API

## [1.1.0] - 2026-03-06

### Added
- Integration test suite: Binance, Bybit, E2E signal, spot-fallback, limit-orders, multiple-symbols, error-handling
- Test helpers: `describeIfCredentials()`, `waitForTickers()`, `calculateTestAmount()`
- Demo trading support via `ExchangeConfig.demo`
- Jest integration config with 180s timeout

### Changed
- Removed testnet support in favor of demo trading

## [1.0.0] - 2026-03-03

### Added
- `ExchangeConnector` with futures/spot support, ticker caching, symbol prefix resolution
- `OrderCalculator` with static methods: `resolveSymbolsForExchanges`, `createOrderAttributesForSymbol`, `enrichWithSpotFallback`, `calculateCloseOrder`, `calculateLimitOrderWithPriceAdjustment`, `setupLeverageAndMarginMode`
- `OrderExecutor` base class with TP/SL and emergency exit
- `TelegramNotifier` (Telegraf bot) and `TelegramMessageListener` (MTProto)
- `TelegramCommandHandler<T>` with typed boolean/numeric settings
- `FirebaseService<T>` with Firestore CRUD and real-time subscriptions
- `ConfigManager` for environment variable validation
- Utility functions: `isOrderSuccessful`, `isSpot`, `normalizeSymbol`, `formatTimestamp`, `createLogger`
- Error-as-value pattern for all trading operations

[3.4.0]: https://github.com/solncebro/trade-engine/releases/tag/v3.4.0
[3.3.1]: https://github.com/solncebro/trade-engine/releases/tag/v3.3.1
[3.3.0]: https://github.com/solncebro/trade-engine/releases/tag/v3.3.0
[3.2.0]: https://github.com/solncebro/trade-engine/releases/tag/v3.2.0
[3.1.5]: https://github.com/solncebro/trade-engine/releases/tag/v3.1.5
[3.1.4]: https://github.com/solncebro/trade-engine/releases/tag/v3.1.4
[3.1.3]: https://github.com/solncebro/trade-engine/releases/tag/v3.1.3
[3.1.2]: https://github.com/solncebro/trade-engine/releases/tag/v3.1.2
[3.0.2]: https://github.com/solncebro/trade-engine/releases/tag/v3.0.2
[3.0.1]: https://github.com/solncebro/trade-engine/releases/tag/v3.0.1
[3.0.0]: https://github.com/solncebro/trade-engine/releases/tag/v3.0.0
[2.2.0]: https://github.com/solncebro/trade-engine/releases/tag/v2.2.0
[2.1.1]: https://github.com/solncebro/trade-engine/releases/tag/v2.1.1
[2.1.0]: https://github.com/solncebro/trade-engine/releases/tag/v2.1.0
[2.0.0]: https://github.com/solncebro/trade-engine/releases/tag/v2.0.0
[1.2.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.2.0
[1.1.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.1.0
[1.0.0]: https://github.com/solncebro/trade-engine/releases/tag/v1.0.0
