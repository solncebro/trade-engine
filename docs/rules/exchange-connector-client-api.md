# ExchangeConnector — справочник методов ExchangeClient

Часть `exchange-connector.md` (см. индекс там). Полный перечень методов, доступных через `connector.spot` / `connector.futures`.

### Полный справочник методов ExchangeClient

Все методы доступны через `connector.spot` / `connector.futures`:

**Символы и тикеры:**
- `loadTradeSymbols()` — загрузка торговых символов. Руками её звать не нужно: `ExchangeConnector.initialize()` грузит оба рынка сам и дальше сам же обновляет их **раз в сутки, в ближайшие 00:05 по всемирному времени со случайным сдвигом 0–120 секунд** (`refreshAllTradeSymbols()` — тот же круг по требованию, `tradeSymbolsRefreshIntervalMs: 0` — выключить таймер). См. раздел «Суточное обновление инструментов» в [`exchange-connector.md`](exchange-connector.md)
- `fetchTickers()` — получение всех тикеров
- `watchTickers()` — подписка на тикеры через WebSocket

**Свечи:**
- `fetchKlines(symbol, interval, since?, limit?)` — получение свечей
- `fetchAllKlines(options: FetchAllKlinesOptions)` — получение всех свечей с пагинацией
- `subscribeKlines(args: SubscribeKlinesArgs)` — подписка на свечи через WebSocket
- `unsubscribeKlines(symbol, interval)` — отписка от свечей
- `resubscribeKlines(symbol, interval)` — переподписка на свечи (явный реконнект WebSocket-стрима)
- `resubscribeKlineList(subscriptionList: { symbol; interval }[])` — пакетная переподписка на несколько пар за один вызов; очередь исходящих команд держит темп внутри `exchange-engine`. Используется `KlineSubscriptionWatchdog` для восстановления массовой просрочки одним вызовом вместо команды на каждую пару

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
- `createOrderWebSocket(args: CreateOrderWebSocketArgs)` → `Order` — создание ордера через WebSocket
- `cancelOrder(symbol, orderId)` → `Order` — отмена ордера
- `getOrder(symbol, orderId)` → `Order` — получение ордера
- `fetchOpenOrders(symbol)` → `Order[]` — открытые ордера
- `fetchOrderHistory(symbol)` → `Order[]` — история ордеров
- `modifyOrder(args: ModifyOrderArgs)` → `Order` — модификация ордера (single)
- `cancelAllOrders(symbol)` → `void` — отмена всех ордеров
- `createBatchOrders(orderList: CreateOrderWebSocketArgs[])` → `CreateBatchOrdersResult` (= `CreateOrderItemResult[]`, 3.16.0, был `Order[]`) — пакетное создание ордеров с per-order результатом (`{ order: Order | null; isSuccess; errorCode; errorText; rateLimit? }`) — по каждой входной заявке видно, встала она и, если нет, что ответила биржа (Binance Futures chunk=5, Bybit linear=20 / spot=10; Bybit идёт через WS если подключён)
- `cancelBatchOrders(symbol, orderIdList)` → `CancelBatchOrdersResult` (= `CancelOrderItemResult[]`) — пакетная отмена с per-order результатами (тип возврата изменён в 0.14.0, был `void`)
- `modifyBatchOrders(orderList: ModifyBatchOrderArgs[])` → `ModifyBatchOrdersResult` (= `ModifyOrderItemResult[]`) — пакетная модификация (0.14.0). Binance Futures REST chunk=5, Bybit linear=20 / spot=10; Bybit идёт через WS если подключён. На Binance Spot бросает `Not supported for spot market`.

**Rate Limit (0.14.0):**
- `getOrderRateLimit()` → `Promise<OrderRateLimit>` — `{ writeRequestsPerSecond, source: 'binance-exchange-info' | 'bybit-documented' | 'fallback' }`. Binance: парсится из `/exchangeInfo` rateLimits → минимум RPS среди ORDERS-ограничений. Bybit: hardcoded 20 RPS (документация V5).

**Аккаунт:**
- `fetchFeeRate(symbol)` → `FeeRate` — комиссии
- `fetchIncome(symbol)` → `Income[]` — доходы/расходы
- `fetchClosedPnl(symbol)` → `ClosedPnl[]` — закрытые PnL

**Public stream (0.14.0, Bybit only — Binance бросает `Not supported`):**
- `subscribeOrderbook(args: SubscribeOrderbookArgs)` / `unsubscribeOrderbook(args)` — Bybit V5 топик `orderbook.{depth}.{symbol}`.
- `subscribePublicTrades(args: SubscribePublicTradesArgs)` / `unsubscribePublicTrades(args)` — Bybit V5 топик `publicTrade.{symbol}`.

**Precision:**
- `amountToPrecision(symbol, amount, rounding?)` → `number` — округление количества
- `priceToPrecision(symbol, price, rounding?)` → `number` — округление цены; `rounding: StepRounding` — `'nearest'` (по умолчанию), `'up'`, `'down'`
- `getMinOrderQty(symbol)` → `number` — минимальный объём ордера
- `getMinNotional(symbol)` → `number` — минимальный notional

**WebSocket:**
- `isTradeWebSocketConnected()` → `boolean` — статус торгового WS
- `connectTradeWebSocket()` — подключение торгового WebSocket
- `getWebSocketConnectionInfoList()` → `WebSocketConnectionInfo[]` — информация о WS-соединениях
- `awaitWebSocketConnectionsReady()` → `Promise<void>` (0.13.0+) — дождаться готовности всех WS после подписок (Binance Futures multi-connection; на других стримах сразу resolve).

**User Data Stream — Binance Spot через WebSocket API (exchange-engine d93c52a):** Binance Spot user-data теперь идёт через WebSocket API (класс `BinanceSpotUserDataStream`; listenKey REST удалён биржей 2026-02-20). `UserDataStreamHandlerArgs.onBalanceUpdate?` (опциональный) эмитит баланс по событию `outboundAccountPosition` через типы `BalanceUpdateEvent` / `BalanceUpdateItem`.
