# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

# ⛔️ ЖЁСТКОЕ ПРАВИЛО — ЛЮБАЯ ЦЕНА НАРУЖУ ТОЛЬКО ЧЕРЕЗ `formatPrice`

**Читать первым. Действует и в этой библиотеке, и во ВСЕХ приложениях, которые её используют (rubber, ma-chaser, volume-breaker, любые новые).**

Ни одно ценовое число не показывается человеку в сыром виде — ни в сообщении Telegram, ни в тревоге, ни в логе, ни в строке журнала, ни в документации.

```typescript
import { formatPrice, snapPriceToTick } from '@solncebro/trade-engine';

// ❌ ЗАПРЕЩЕНО — сырое число с хвостом плавающей точки
logger.warn(`${symbol}: stop re-derived → trigger ${recomputedPrice}`);
// → "trigger 2.961579786096256" — человеком не читается и НЕ равно тому, что стоит на бирже

// ✅ ЕДИНСТВЕННЫЙ допустимый способ
logger.warn(`${symbol}: stop re-derived → trigger ${formatPrice(symbol, recomputedPrice)}`);
// → "trigger 2.9616" — ровно то, что реально лежит в заявке
```

- `formatPrice(symbol, price)` — строка на тиковой сетке символа (`—`, если цены нет).
- `snapPriceToTick(symbol, price)` — то же числом (для записи в базу/журнал).
- Подключается **само**: `ExchangeConnector.initialize()` ставит источник тиковой сетки. Приложению делать ничего не нужно. Без коннектора (бэктест, утилиты) — `configurePriceTickSnapper(...)` вручную.
- Символ без загруженных биржевых фильтров печатается не длиннее 8 знаков после точки.

**Правило распространяется на ЛЮБОЕ вычисленное число, а не только на цену.** Объём в USDT, маржа, количество контрактов, процент, среднее — всё, над чем было совершено математическое действие, несёт хвост плавающей точки и наружу (Telegram, тревоги, логи, журнал) выходит только через форматтер из `src/utils/numberFormat.ts`:
- `formatAmount(symbol, amount)` / `snapAmountToStep(symbol, amount)` — количество контрактов на шаге количества символа (подключается в `ExchangeConnector.initialize()` вместе с тиковой сеткой; без коннектора — `configureAmountStepSnapper(...)`).
- `formatUsdAmount(value)` / `roundUsdAmount(value)` — суммы USDT, не точнее цента.
- `formatPercent(value, digits = 2)` / `roundPercent(value, digits = 2)` — проценты.
- `formatX` — для строк текста, `snapX`/`roundX` — для числовых полей объекта логгера и записей журнала. Значения, идущие в расчёты и на биржу, не трогать — форматирование стоит только в точке вывода.

**Почему это правило существует:** заявка на бирже ВСЕГДА лежит на тиковой сетке, поэтому сырое `2.961579786096256` не просто нечитаемо — оно расходится с фактом. Владелец натыкался на это многократно (последний раз 11.08.2026) и требует системности, а не разовых исправлений. Модули — `src/utils/priceFormat.ts` (цена, сторож `tests/priceFormat.test.ts`) и `src/utils/numberFormat.ts` (3.23.0; всё остальное вычисленное число, сторож `tests/numberFormat.test.ts`).

**Проверка перед сдачей работы:** поиск по правкам на интерполяцию числа (`${...Price}`, `price=${`, `${...price}`, `${...amount}`, `${...Percent}`, `${...Usdt}`) — каждое такое место обязано быть завёрнуто в `formatPrice`/`formatAmount`/`formatPercent`/`formatUsdAmount`.

---

## Команды

```bash
# Сборка (lint → тесты → tsc)
yarn build

# Юнит-тесты
yarn test

# Проверка типов
npx tsc --noEmit

# Линтинг
yarn lint
yarn lint:fix

# Живые проверки на демо-счетах (нужны demo API-ключи в .env.test)
# Ставят заявки ~100 USDT и закрывают их тут же, в том же тесте — это штатно
yarn test:integration              # все
yarn test:integration:binance      # Binance
yarn test:integration:bybit        # Bybit
yarn test:integration:okx          # OKX

# Один юнит-тест
npx jest tests/utils.test.ts

# Один интеграционный тест
npx jest --config jest.integration.config.js --runInBand --testPathPatterns=<pattern>
```

**Jest 30** — флаг `--testPathPatterns` (множественное число), не `--testPathPattern`.

## Архитектура

**@solncebro/trade-engine** — библиотека торгового движка для Binance и Bybit с интеграцией Telegram и Firebase.

### Путь «Сигнал → Ордер»

Расчёта сигнала в библиотеке больше нет: статический класс `OrderCalculator` (разбор символов
сигнала, объём по сигналу, запасной путь через спот, лимитная цена с отступом в процентах) уехал
в область листингов в 3.13.0. Что и на сколько покупать, решает приложение; библиотека исполняет.

1. Сигнал приходит (Telegram / WebSocket) — приложение само считает символ, объём и сторону
2. `ExchangeConnector.resolveSymbolWithPrefix(symbol, marketType)` — имя символа на этой бирже
   с учётом приставок: сперва имя как есть, затем `10` / `100` / `1000` / `10000` / `100000` /
   `1000000` по кэшу тикеров (`1000FLOKIUSDT` и подобные). Ничего не нашлось — предупреждение
   в журнал и имя возвращается как есть
3. `connector.positionManager.*` — деловой вход (`openPositionLimit/Market`, `closePosition*`,
   `placeStopLoss/TakeProfit`): по направлению сделки сам выводит сторону заявки, в двустороннем
   режиме счёта — сторону позиции, признак «только уменьшать» (на Binance в этом режиме он не
   ставится — биржа не принимает его вместе со стороной позиции), при необходимости заранее
   ставит плечо и режим маржи. Все записи идут через очередь ограничения частоты и повтор на 429
4. `ExchangeConnector.createOrder(orderParams)` — единственная дверь на биржу: количество и цена
   сажаются на сетку символа, срок действия проставляется сам (рыночная — «исполнить и отменить
   остаток», прочие — «до отмены»), цена срабатывания уходит отдельным полем, заявка отправляется
   через `createOrderWebSocket` нижней библиотеки. Ошибка не бросается — возвращается полями
   `errorText` / `errorCode` результата
5. Старый путь для наследования — `OrderExecutor`: `createOrder()` и `createCloseOrder()`, где
   закрывающая заявка собирается на месте (`buildCloseOrderParams`: обратная сторона, цена со
   сдвигом на процент, у стоп-лосса — цена и сторона срабатывания, на срочном рынке — «только
   уменьшать»; аварийный выход превращает её в рыночную без срабатывания). Новые проекты — через
   `PositionManager`

### Подробная документация

| Файл | Содержание |
|------|-----------|
| [`.Codex/rules/architecture.md`](.Codex/rules/architecture.md) | Архитектура, слои, потоки данных, схема пайплайна |
| [`.Codex/rules/exchange-connector.md`](.Codex/rules/exchange-connector.md) | ExchangeConnector: подключение, тикеры, префиксы, demo trading (индекс; темы ниже — сателлиты) |
| [`.Codex/rules/exchange-connector-client-api.md`](.Codex/rules/exchange-connector-client-api.md) | Полный справочник методов `ExchangeClient` (`connector.spot` / `connector.futures`) |
| [`.Codex/rules/exchange-connector-orders.md`](.Codex/rules/exchange-connector-orders.md) | Создание ордеров (`buildCreateOrderArgs`), отличия OKX, методы `PositionManager` |
| [`.Codex/rules/exchange-connector-streams.md`](.Codex/rules/exchange-connector-streams.md) | `KlineSubscriptionWatchdog`, `StreamSubscriptionWatchdog`, стакан (`OrderBookTracker`) |
| [`.Codex/rules/types.md`](.Codex/rules/types.md) | Система типов: OrderParams, OrderResult, маппинги, конфиги |
| [`.Codex/rules/services.md`](.Codex/rules/services.md) | Telegram, Firebase, Logger, утилиты |
| [`.Codex/rules/testing.md`](.Codex/rules/testing.md) | Тестирование: команды, паттерны, хелперы, символы |
| [`.Codex/rules/code-conventions.md`](.Codex/rules/code-conventions.md) | Конвенции: форматирование, импорты, именование, паттерны |
| [`.Codex/rules/strategy-trading.md`](.Codex/rules/strategy-trading.md) | Слой стратегической торговли: `OrderManager`, базовый `PositionMonitor` (+ хуки, порты `PositionStore`/`MarketDataSource`), подключаемый `GenericPnlMonitor` (opt-in PnL-бот позиций), `ChartGenerator`, модель `MonitoredPosition`, утилиты слоя |
| [`.Codex/rules/strategy-trading-order-manager.md`](.Codex/rules/strategy-trading-order-manager.md) | `OrderManager`: конструктор, публичный интерфейс, ключевые поведения (гарантированная отмена, per-position FIFO, идемпотентность SL, sub-batch splitting), константы |
| [`.Codex/rules/strategy-trading-monitors.md`](.Codex/rules/strategy-trading-monitors.md) | `PositionMonitor` и `GenericPnlMonitor`: конструкторы, что реализуют сами, protected-хуки, Telegram-меню позиций, константы |
| [`.Codex/rules/trend.md`](.Codex/rules/trend.md) | Определение тренда: `TrendCalculator` (структура рынка — вершины/впадины, направление, слом, сила 0–100), `TrendMonitor` (живой наблюдатель + событие смены тренда), `formatTrendSummaryMessage` |

### Ключевые модули

- **`src/services/exchangeConnector.ts`** — обёртка над `@solncebro/exchange-engine`. Подключения, тикеры, mark price WebSocket, резолвинг символов, исполнение ордеров; для futures — `futuresPositionMode` (OneWay / Hedge) влияет на авто-`positionSide` в `createOrder` (legacy safety-net). Прямой доступ к клиентам через `connector.spot` / `connector.futures` (с Proxy для kline watchdog при включении). Lazy-init `connector.positionManager` — высокоуровневый API. 5/6-й аргументы конструктора (3.5.0): `klineWatchdogConfig?`, `rateLimitConfig?`. → [подробнее](.Codex/rules/exchange-connector.md)
- **`src/core/positionManager.ts`** — `PositionManager`, высокоуровневый семантический API для spot/futures (`openPositionLimit/Market`, `openPositionBatchLimit`, `closePositionLimit/Market`, `closePositionBatchLimit`, `placeStopLoss/TakeProfit`, `cancelOrder/cancelBatchOrders/cancelAllOrders`, `modifyOrder/modifyBatchOrders`, `spotMarketBuyByQuote`, `setLeverage/setMarginMode`, `readPositionState/readAllPositions` — последние два только futures). Все write-операции — через `RateLimitedRequestQueue` + `withRetryOn429` (3.5.0). Скрывает `positionSide`/`positionIdx`/`reduceOnly`/`closePosition`/`workingType`/`triggerDirection`/`triggerBy`/`orderFilter`/`marketUnit` от приложений; принимает бизнес-аргументы (`symbol`, `marketType`, `direction`, `amount`, `price`/`triggerPrice`). На spot `direction='short'` бросает synchronous Error.
- **`src/core/RateLimitedRequestQueue.ts`** (3.5.0) — sliding-window очередь для контроля RPS write-операций.
- **`src/core/withRetryOn429.ts`** (3.5.0) — `withRetryOn429` (+ `withResultRetry`) — retry-обёртки с exponential backoff на 429/5xx. `withReadRetry` удалён в 3.22.0 (был той же функцией под вторым именем).
- **`src/services/streamSubscriptionWatchdog.ts`** — ЕДИНЫЙ сторож здоровья WS-подписок; поведение потока задаёт `StreamWatchdogStrategy` (`streamWatchdogStrategies.ts` — стакан/сделки/mark-цена; `klineWatchdogStrategy.ts` — клайны, 3.22.0). `klineSubscriptionWatchdog.ts` — тонкая обёртка с прежним интерфейсом.
- **`src/services/orderBookTracker.ts`** (3.22.0) — живая склеенная книга по подписке; наружу — `ExchangeConnector.subscribeOrderBook/getOrderBook/unsubscribeOrderBook/fetchOrderBook`. Чтение стакана через сырой клиент (`getClient(...).subscribeOrderbook`) — обход единой двери. Чистый срез объёма по полосе — `sliceAskVolumeWithinBand` (`src/utils/orderBookSlice.ts`).
- **`src/services/premiumIndexCalculator.ts`** — `PremiumIndexCalculator`, per-symbol EMA «премии» (`midPrice − markPrice`, окно 30s); Bybit это значение публично не отдаёт, поэтому потребитель считает его сам и забирает через `getPremiumAvg`. Расчёта ценовых границ в библиотеке нет — он уехал вместе с `OrderCalculator` в 3.13.0, остались только типы `PriceLimitBoundsArgs` / `PriceLimitBounds`. Не auto-wired. → [подробнее](.Codex/rules/services.md)
- **`src/services/tradifiSymbolGate.ts`** (3.12.0) — `TradifiSymbolGate`, переиспользуемый хранитель «универса без TradFi» (`isAllowed`/`classify`/`filterSymbolList`); опциональный `shouldAllowTradifi` (3.13.0, default `false`) снимает фильтр по явному согласию потребителя. → [подробнее](.Codex/rules/services.md)
- **`src/core/trendCalculator.ts` + `src/core/TrendMonitor.ts`** (3.14.0) — определение тренда актива по структуре рынка (вершины/впадины). `TrendCalculator` — статический расчёт направления (рост/падение/боковик), слома тренда по закрытию и силы 0–100. `TrendMonitor` — живой наблюдатель поверх `MarketDataSource`: вердикт по каждому интервалу + сводка, событие `trendChanged` при смене направления, чистое снятие подписок. `formatTrendSummaryMessage` — текст сводки для Telegram. Не торгует и не шлёт сам. → [подробнее](.Codex/rules/trend.md)
- **`src/core/orderExecutor.ts`** — базовый класс исполнения ордеров с TP/SL и аварийным выходом (legacy путь; новые проекты — через `PositionManager`). Сборка закрывающей заявки живёт здесь же (`buildCloseOrderParams`, приватный) — она перешла сюда из `OrderCalculator.calculateCloseOrder` в 3.13.0: расчёт общий, а место применения единственное. `positionSide` копируется из исходного `orderParams` — нужно для двустороннего режима.
- **`src/services/telegram*.ts`** — Telegram-бот (Telegraf) + MTProto-слушатель. → [подробнее](.Codex/rules/services.md)
- **`src/services/firebaseServiceBase.ts`** — базовый класс Firestore CRUD с real-time подпиской; `updateData` использует `flattenForFirestoreUpdate` (3.5.0). → [подробнее](.Codex/rules/services.md)

#### Слой стратегической торговли (влит из бывшего `@solncebro/ma-trading-core`)

- **`src/core/OrderManager.ts`** — фоновый исполнитель всех ордерных операций (cancel/replace/place/close, batch) с WS+REST verify, retry, per-position FIFO, sub-batch splitting ≤10, RAM-only. → [подробнее](.Codex/rules/strategy-trading.md)
- **`src/core/PositionMonitor.ts`** — базовый headless-класс мониторинга позиций: poll-цикл, SL/TP, реконсиляция внешнего закрытия, drain multi-entry, WS-хендлеры, protected-хуки для подклассов; порты `PositionStore` (`positionStore.types.ts`) и `MarketDataSource` (`marketDataSource.types.ts`). → [подробнее](.Codex/rules/strategy-trading.md)
- **`src/core/GenericPnlMonitor.ts`** — `extends PositionMonitor`; подключаемый **opt-in** PnL-слой со своим Telegram-ботом позиций (profit/loss alerts, trailing SL, auto-close, SOS halve-at-breakeven, Split-TP, импорт/эфемерные). Пороги через callback `getPnlConfig(): PnlConfig`; app-специфика — через protected-хуки (`onLossThresholdReached`, `onCancelSos`, `resolveInsuranceViewState`, `registerInsuranceCallbackHandlers`, …). Без chaser/insurance-связности. → [подробнее](.Codex/rules/strategy-trading.md)
- **`src/chart/ChartGenerator.ts`** — candlestick-PNG через ECharts SSR + resvg (`generateChart` / `generateVolumeMontageChart`). → [подробнее](.Codex/rules/strategy-trading.md)
- **`src/types/strategy.ts`** — модель `MonitoredPosition` / `MaValues` / `MaLevel` + константы `VOLUME_SMA_PERIOD`, `MA_LEVEL_LIST`, `ALL_SUPPORTED_INTERVAL_LIST`. → [подробнее](.Codex/rules/strategy-trading.md)

### Ключевые принципы

- **Ошибки — не исключения**: `createOrder()` возвращает `errorText` в результате, не бросает. Проверка через `isOrderSuccessful(result)`. Прямые вызовы `connector.spot`/`connector.futures` могут бросать исключения — потребитель обрабатывает их сам.
- **Единая точка входа**: внешние приложения импортируют ТОЛЬКО из `@solncebro/trade-engine`. Прямые импорты из `@solncebro/exchange-engine` запрещены. Значения нижней библиотеки реэкспортируются поимённо (`formatWebSocketConnectionsReport` и т.д.) — кроме фабрики `Exchange`, которая остаётся доступна ТОЛЬКО как тип (3.19.0). Типы нижней библиотеки отдаются сквозняком — `export type * from '@solncebro/exchange-engine'` — без поимённого перечня, поэтому новый тип виден потребителю сам.
- **Demo trading**: `ExchangeConfig.isDemoMode = true`, никаких ручных URL-переопределений.
- **Биржи**: `@solncebro/exchange-engine` `>=0.22.0 <1.0.0` (из реестра npm, диапазон, а не точная версия — с 3.21.0). Bybit: WebSocket для ордеров.
- **Map-коллекции**: `SymbolMappingByExchange` и `ExchangeConnectorByName` — это `Map`, не объекты.

### Живые проверки на демо-счетах (`tests/integration/`)

- Три набора: `binance.test.ts` (16), `bybit.test.ts` (16), `okx.test.ts` (17). Каждый — блок
  `ExchangeConnector` (имя биржи, номер счёта, списки инструментов, тикер, разрешение символа,
  плечо, режим маржи, заявки, позиция, стакан) и блок `PositionManager` (чтение позиций, плечо,
  открытие и закрытие рыночной заявкой)
- `.env.test` с `BINANCE_DEMO_API_KEY`, `BINANCE_DEMO_SECRET_KEY`, `BYBIT_DEMO_API_KEY`,
  `BYBIT_DEMO_SECRET_KEY`, а для OKX — **тремя** переменными: `OKX_DEMO_API_KEY`,
  `OKX_DEMO_SECRET_KEY`, `OKX_DEMO_PASSPHRASE` (кодовую фразу OKX требует в подписи каждого запроса)
- Тесты автоматически пропускаются при отсутствии ключей (`describeIfCredentials()`)
- Хелперы: `tests/integration/helpers/testnet.helpers.ts` — конфиги, символы, своё чтение
  `.env.test` и `createDemoConnector()` (спрашивает у счёта его режим позиций и собирает
  коннектор под ответ — иначе счёт в режиме «лонг и шорт» отвергает заявки без стороны позиции)
- Всегда `--runInBand` (последовательно), таймаут 180 сек
- Интеграционные команды запускаются через `scripts/runIntegrationJest.js`, который очищает proxy-переменные окружения (`HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/GIT_HTTP_PROXY/GIT_HTTPS_PROXY/SOCKS_PROXY/SOCKS5_PROXY` и lowercase-варианты)
- → [подробнее](.Codex/rules/testing.md)

#### Граница с exchange-engine

Здесь проверяется ТОЛЬКО обёртка: разрешение имени символа с приставками, кэш тикеров, поведение
самого коннектора и потоки `PositionManager` / `OrderExecutor` — то есть то, что эта библиотека
добавляет поверх нижней. Договор с биржей — единицы объёма, знаки, инварианты ответов, потоки
котировок и заявок — проверяется живыми пробами соседней библиотеки, в `../exchange-engine/scripts/`
(инструкция — `README.md` там же; проба OKX — `okx-live-probe`, общая проверка договора —
`exchange-live-check`). Дублировать эти проверки здесь запрещено: две копии одной правды расходятся,
и по расхождению уже не понять, где ошибка — в обёртке или в договоре.
