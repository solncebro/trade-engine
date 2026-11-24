# ExchangeConnector — заявки и позиции

Часть `exchange-connector.md` (см. индекс там). Создание ордеров, отличия OKX, высокоуровневые методы `PositionManager`.

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

Особенности `buildCreateOrderArgs` (3.4.0):
- **Spot vs futures разведены.** На spot НЕ выставляются `positionSide`/`reduceOnly`/`closePosition`/`workingType`/`triggerDirection`/`triggerBy`/`closeOnTrigger` — даже если приложение их передаёт в `orderParams`, биржевой слой их не получит.
- **positionSide (futures).** Явный `orderParams.positionSide` используется без изменений. Если не задан: в OneWay поле не передаётся, в Hedge — smart-inference как safety net (открытие: `Buy → Long`, `Sell → Short`; close при `reduceOnly=true`: `Sell → Long`, `Buy → Short`). Идиоматический путь — `connector.positionManager.*`, где `positionSide` всегда явный, а safety-net не задействован.
- **reduceOnly.** Читается и из top-level `OrderParams.reduceOnly`, и из nested `params.reduceOnly` (top-level ранее терялся, фикс 3.4.0).
- **Дополнительные поля** (futures, если заданы): `triggerBy`, `closeOnTrigger`, `closePosition`, `workingType`, `triggerDirection`. **На spot**: `orderFilter` (Bybit), `marketUnit` (Bybit), `quoteOrderQty`. **Универсально**: `clientOrderId`, `callbackRate` (3.16.0, проценты — скользящий стоп на любом рынке), `activationPrice` (3.16.0, приводится к сетке цены символа).
- **Market.** Поле `price` в `OrderParams` может передаваться для удобства, но для `OrderTypeEnum.Market` не форвардится в wire-параметры.
- **timeInForce.** Все биржи: `IOC` для Market; прочие — `orderParams.timeInForce ?? GTC` (в т.ч. `StopLimit`/`TakeProfitLimit` на spot). См. «Срок действия» ниже.
- **Stop Loss.** `triggerPrice` (через `stopPrice`) и `triggerDirection` если указаны.

### Срок действия (timeInForce, 3.24.0)

`OrderParams.timeInForce?: TimeInForceEnum`. `buildCreateOrderArgs`: рыночная — всегда `Ioc`; любая другая —
`orderParams.timeInForce ?? Gtc`. Поле есть у `openPositionLimit`, `closePositionLimit`,
`openPositionBatchLimit` / `closePositionBatchLimit` (на весь пакет). `PostOnly` нижняя библиотека переводит
сама (Binance фьючерсы — GTX, Binance спот — LIMIT_MAKER).

`isPostOnlyRejection({ errorCode?, rejectReason? })` (src/utils/orderRejection.utils.ts): Binance фьючерсы — синхронный
отказ -5022 (`OrderResult.errorCode`), Bybit — заявка принята и снята, причина `EC_PostOnlyWillTakeLiquidity`
приходит в `OrderUpdateEvent.rejectReason`. Binance спот и OKX не покрыты — коды не подтверждены.

### Чем OKX отличается от Binance и Bybit

Всё перечисленное прячет `exchange-engine`; в trade-engine отдельных веток под это НЕТ, и заводить их не нужно.

- **Единицы контрактов скрыты.** Наружу `amount` всегда в монетах. Перевод в контракты (`ctVal` монет в одном контракте) и обратно делает биржевой слой; `amountToPrecision` у бессрочных округляет ВНИЗ до целого числа контрактов — то же число, что реально уйдёт на биржу. Объём меньше одного контракта — отказ, а не молчаливый ноль.
- **Условные заявки уходят в отдельную службу.** У OKX для них свой набор полей и свой эндпоинт; `createOrderWebSocket` сам разводит обычные и условные типы. Отмена и чтение такой заявки идут туда же.
- **Режим маржи — память клиента, а не отказ.** `setMarginMode` у OKX не переключает ничего на бирже: значение запоминается клиентом и прикладывается к следующим заявкам. Если на символе уже стоит позиция в другом режиме, клиент пишет предупреждение — «новый режим применится со следующих заявок».
- **Клиентский номер заявки — только латинские буквы и цифры, 1–32 знака. Это ОБЩЕЕ правило для приложения под любую биржу, а не только под OKX.** Требование самое строгое у OKX: `clientOrderId` с дефисом, точкой или двоеточием она отвергает, и биржевой слой ловит это заранее (`OKX_CLIENT_ORDER_ID_INVALID`), не доводя до биржи. Binance и Bybit допускают до 36 знаков с дефисом и подчёркиванием, но приложение, которое собирает номер под одну биржу с дефисом, на OKX получит отказ на каждой заявке — поэтому номер всегда собирается по общему правилу.
- **Сторона позиции обязательна в двустороннем режиме.** На счёте `long_short_mode` заявка без стороны отвергается (`OKX_POSITION_SIDE_REQUIRED`), а запрет на увеличение (`reduceOnly`) там на провод не идёт вовсе — клиент его выбрасывает сам, спросив у счёта его настоящий режим. В одностороннем — наоборот. Поэтому `futuresPositionMode` коннектора должен совпадать с настоящим режимом счёта; узнать его — `connector.futures.fetchPositionMode()`.
- **Рыночная покупка на споте по сумме.** Достаточно `quoteOrderQty` — клиент OKX сам поймёт, что объём задан в котируемой валюте, и проставит нужную единицу на проводе. `marketUnit` (как для Bybit) не нужен.

## PositionManager — методы

`connector.positionManager` — lazy-init высокоуровневый API (файл `src/core/positionManager.ts`). Помимо одиночных open/close/SL/TP/cancel/modify (см. таблицу публичных методов в [`exchange-connector.md`](exchange-connector.md) и `CLAUDE.md`), доступны batch- и read-методы:

| Метод | Возвращает | Описание |
|-------|-----------|----------|
| `openPositionBatchLimit(args: OpenPositionBatchLimitArgs)` | `Promise<OpenPositionBatchLimitResult>` | Пакетное открытие лимитных позиций по одному символу (`itemList`); применяет `applyFuturesSetup` (leverage/marginMode) один раз; пустой `itemList` → `[]` |
| `closePositionBatchLimit(args: ClosePositionBatchLimitArgs)` | `Promise<ClosePositionBatchLimitResult>` | Пакетное закрытие лимитными `reduceOnly`-ордерами по одному символу (`itemList`); пустой `itemList` → `[]` |
| `readPositionState(args: ReadPositionStateArgs)` | `Promise<PositionStateResult>` | **Только futures** (иначе throws). Возвращает discriminated union: `{ kind: 'present', position }` / `{ kind: 'absent', confidence, reason }` / `{ kind: 'ambiguous', reason, position }`. Учитывает Hedge/OneWay (`positionIdx`, `side`); в OneWay Binance единственная позиция приходит со стороной `both` и отдельным направлением — позиция с ненулевым объёмом и противоположным направлением даёт `ambiguous/side_mismatch`, как у Bybit |
| `readPositionStateByDirection(args: ReadPositionStateByDirectionArgs)` | `Promise<PositionStateByDirection>` | **Только futures** (иначе throws). `{ long, short }` — обе стороны монеты ОДНИМ чтением списка позиций (`fetchPositionList(symbol)`); каждая сторона классифицируется теми же правилами, что в `readPositionState`. Отказ чтения — обе стороны `absent/unconfirmed/fetch_error` (не «позиции нет») |
| `readAllPositions(args: ReadAllPositionsArgs)` | `Promise<Position[]>` | **Только futures** (иначе throws). `connector.futures.fetchAllPositions()`; при ошибке re-throws; строки запроса/ответа — уровнем `debug` |
| `readOpenOrderList(args: ReadOpenOrderListArgs)` | `Promise<Order[]>` | Все открытые заявки по символу. Futures: параллельно `fetchOpenOrders(symbol)` + `fetchOpenConditionalOrders('USDT', symbol)` (биржа отдаёт условные заявки только этого инструмента), слиты и дедуплицированы по `order.id`: обычный список на всех биржах содержит только обычные заявки (Bybit спрашивается с `orderFilter=Order`), условные приходят отдельным вызовом. Spot: только `fetchOpenOrders(symbol)`. Отказ — предупреждение в лог и повторный throw (не путать «заявок нет» с отказом чтения) |
| `readOrder(args: ReadOrderArgs)` | `Promise<Order>` | Одна заявка по её номеру биржи (`client.getOrder`); при ошибке — строка в журнал уровнем `debug` и re-throw; строки запроса/ответа — уровнем `debug` |
| `readOrderByClientOrderId(args: ReadOrderByClientOrderIdArgs)` | `Promise<Order>` | Одна заявка по СВОЕМУ номеру (`client.getOrderByClientOrderId`) — приложение, записавшее номер в своё хранилище до отправки, находит заявку по нему после потерянного ответа; при ошибке — строка в журнал уровнем `debug` и re-throw; строки запроса/ответа — уровнем `debug` |
| `readFeeRate(args: ReadFeeRateArgs)` | `Promise<FeeRatePercent \| null>` | Комиссия мейкера/тейкера символа в ПРОЦЕНТАХ (`{ makerPercent, takerPercent }`) — `exchange-engine` отдаёт доли (0.0002 = 0.02 %), переведено один раз. Пустой список ответа биржи или нечисловой результат → `null`; отказ чтения → предупреждение в лог и `null` (НЕ throw — комиссия оценочная, вызывающий подставляет значение по умолчанию) |
| `readAccountTrades(args: ReadAccountTradesArgs)` | `Promise<AccountTrade[]>` | Исполнения счёта по символу за окно (`client.fetchAccountTrades(symbol, { startTime?, endTime?, limit? })`), путём чтения с повтором при ограничении частоты; отказ передаётся вызывающему |
| `readPositionLeverage(symbol: string)` | `Promise<number \| null>` | Текущее плечо позиции фьючерсов (`futures.fetchPositionLeverage`): Binance — из настроек символа, Bybit — из списка позиций монеты; `null` — биржа значения не дала (пусто, портфельная маржа, разное плечо ячеек); путь чтения, отказ передаётся вызывающему |
| `readFundingRateHistory(args: ReadFundingRateHistoryArgs)` | `Promise<FundingRateHistoryPercent[] \| null>` | Все записи ставки финансирования, которые биржа вернула за включительное окно времени в миллисекундах. Передаёт `shouldIncludeMarkPrices` нижней библиотеке. Читает путём чтения (без очереди записей) с повтором при ограничении частоты; короткая страница не считается концом: Bybit отдаёт не больше 200 записей начиная с новых, Binance — до 1000 начиная со старых, поэтому обе стороны каждой страницы дочитываются до пустого ответа. Удаляет повторы по времени, возвращает ставку в процентах. Пустой ответ → `[]`; отказ или страница целиком вне запрошенного окна → предупреждение в журнал и `null`. Непрерывность ряда и достаточность записей вокруг расчётного окна проверяет вызывающая сторона |
| `readIncome(args: ReadIncomeArgs)` | `Promise<Income[]>` | Записи доходов счёта (фандинг, комиссии, реализованный итог) за окно; путь чтения с повтором при ограничении частоты, без очереди записей |
| `readOrderHistory(args: ReadOrderHistoryArgs)` | `Promise<Order[]>` | История заявок по символу (`{ symbol, marketType, ...page }`); путь чтения с повтором при 429 |
| `readClosedPnl(args: ReadClosedPnlArgs)` | `Promise<ClosedPnl[]>` | Закрытые итоги (`{ symbol?, ...page }`); путь чтения с повтором при 429 |
| `readMarkPrice(symbol: string)` | `Promise<MarkPrice \| null>` | Одна строка маркировочной цены символа или `null`, если биржа строк не дала; отказ чтения передаётся вызывающему; путь чтения |
| `readAccountBalance()` | `Promise<AccountBalanceSnapshot \| null>` | Баланс счёта через утилиту баланса (повтор внутри); `null` — баланс не прочитан, это НЕ нулевой баланс; путь чтения |
| `readOpenPlainOrderList(args: ReadOpenPlainOrderListArgs)` | `Promise<Order[]>` | Открытые обычные заявки (`{ marketType, symbol? }`); путь чтения |
| `readOpenConditionalOrderList(args: ReadOpenConditionalOrderListArgs)` | `Promise<Order[]>` | Открытые условные заявки (`{ symbol?, settleCoin? = 'USDT' }`): с `symbol` — один запрос по инструменту (биржа сама отбирает заявки инструмента), без него — весь счёт по расчётной монете; путь чтения |

- `PositionManager.cancelOrder(args)` → `CancelOrderResult` `{ orderId, isCancelled: true, filledAmount: number | null }`: ответ биржи на саму отмену, заявка не перечитывается; `filledAmount` посажен на шаг объёма символа, `null` — биржа его не дала (условная заявка Binance, Bybit, OKX). Отказ, в том числе «заявки уже нет», — ошибка с кодом биржи.
- `OrderResult.responseData.amount` / `.status` при постановке — принятый биржей объём и состояние из её ответа (`Order.acceptedAmount`/`acceptedStatus`; Binance урезает закрывающую заявку больше позиции уже здесь); у Bybit и OKX полей нет.
- `OpenPositionBatchLimitResult` / `ClosePositionBatchLimitResult` = `PositionBatchLimitItemResult[]`, где `PositionBatchLimitItemResult = { isSuccess, orderId: string | null, errorText: string | null }`.
- `PositionStateResult` reasons: `PositionAbsenceReason = 'no_record' | 'zero_contracts' | 'fetch_error'`, `PositionAmbiguityReason = 'side_mismatch' | 'idx_mismatch'`.
- `FeeRatePercent = { makerPercent: number; takerPercent: number }` — всегда проценты, никогда доли и никогда базисные пункты.
- `FundingRateHistoryPercent = { symbol, fundingRatePercent, fundingTime, markPrice }`; `markPrice` остаётся `null`, если нижняя библиотека или биржа её не предоставили.


Установка плеча через `PositionManager.setLeverage` принимает необязательное направление `direction` и передаёт его в нижнюю библиотеку. На Bybit при изолированном двустороннем режиме сохраняется плечо встречной стороны; при общем режиме задаётся общее плечо. Без направления остаётся прежнее поведение. Неизвестное состояние нижняя библиотека отклоняет до записи. Необязательный `SetLeverageArgs.timeoutMs` — срок на ВСЮ операцию, считая с вызова: ожидание за другими плечами и входами символа, очередь записи, каждая попытка и каждая пауза `Retry-After`. По истечении вызов отклоняется ошибкой `DeadlineExceededError` (исход неизвестен: биржа могла применить запрос), очередь символа освобождается сразу, новые попытки и паузы не начинаются, летящий запрос обрывается сигналом отмены, переданным в запись нижней библиотеки (`SetLeverageOptions.signal` у exchange-engine). Без `timeoutMs` срока у вызова нет (3.26.0).


Метод `openPositionLimitWithLeverage` принимает `OpenPositionLimitWithLeverageArgs` (параметры обычной лимитной заявки с обязательным плечом). Для фьючерсов он задаёт плечо с направлением сделки, требует точного подтверждения и отправляет первую заявку, удерживая общую для символа последовательность до ответа на заявку. В эту же последовательность входят `setLeverage` и `openPositionLimit`; обычная заявка с плечом сохраняет прежний вызов без направления. Отказ или несовпадение плеча не приводит к заявке. Последовательность ограничена одним экземпляром управляющего позицией и не запрещает дальнейшую торговлю обеих сторон.

Необязательное действие `beforeOrder` входит в `OpenPositionLimitArgs`, `OpenPositionMarketArgs`, `ClosePositionMarketArgs` и `ClosePositionLimitArgs`; вариант открытия с обязательным плечом наследует его. Оно выполняется после ожидания очереди запросов, непосредственно перед созданием заявки; отказ проверки закрытия также не отправляет заявку. При лимитном открытии проверка находится внутри последовательности символа, а в составной операции следует за точным подтверждением плеча. Его отказ прерывает операцию до отправки заявки.

`PlaceStopLossArgs`, `PlaceTakeProfitArgs`, `OpenPositionBatchLimitArgs`, `ClosePositionBatchLimitArgs` и `SpotMarketBuyByQuoteArgs` также поддерживают необязательный `beforeOrder`: проверка выполняется внутри очереди непосредственно перед созданием заявки (у пачки — один раз перед всей пачкой); при отказе проверки ничего не отправляется.

Подтверждённое отсутствие из-за нулевого объёма сохраняет время снимка в `positionUpdatedAtMs`, если биржа его предоставила. Отсутствие записи и ошибка чтения времени не придумывают.

`readPositionState` читает снимок без дополнительных настроек. Пустая ячейка у Binance приходит только пока у символа есть позиция или открытые заявки; иначе состояние `absent/confirmed/no_record`. У Bybit пустая ячейка приходит всегда. Для нулевого объёма принадлежность стороны и ячейки проверяется до подтверждения отсутствия. Несовпадение возвращается как неоднозначное состояние.


`readOrderExecutionSummary` принимает символ, номер заявки, начало и конец окна, тип рынка; путём чтения (без очереди записей) с повтором при ограничении частоты возвращает суммарный исполненный объём и время последнего исполнения. Поддержаны Binance Futures и Bybit Linear. Пустая история возвращает нулевой объём и неизвестное время; совпадение объёма с состоянием заявки проверяет вызывающая сторона. Ошибка полноты или принадлежности истории передаётся вызывающему.


`PositionManager.addIsolatedPositionMargin({ symbol, direction, amount }): Promise<void>` увеличивает изолированную маржу Binance Futures. Требует известного режима позиции и конечной положительной суммы в валюте маржи. В двустороннем режиме выбирает сторону по направлению, в одностороннем — `Both`. Проходит через общую очередь записи без повторов при ошибках. Неизвестный исход требует ручной сверки до любой повторной попытки; текущее `Position.info.isolatedWallet` не является историей конкретной операции.

`readOrderExecutionSummary` сохраняет расширенный ответ нижней библиотеки с исполнениями, фактическим оборотом, средней ценой, комиссиями по валютам и подтверждением полноты окна. Одиночные `closePositionLimit/Market` проходят очередь без повторной отправки при неизвестном исходе: HTTP-запись и WebSocket-запись выполняются однократно; Binance допускает только повтор после явного отказа просроченной подписи.

## Методы коннектора без сырого клиента

| Метод | Возвращает | Описание |
|---|---|---|
| `readKlines({ symbol, interval, marketType, ...page })` | `Promise<Kline[]>` | Клайны через коннектор, без сырого клиента |
| `isUserDataStreamConnected(marketType = Futures)` | `boolean` | Подключён ли личный поток рынка |
| `getRateLimitState(marketType = Futures)` | `ExchangeRateLimitState` | Расход веса и запрет по последнему ответу биржи, без сетевого вызова; неизвестное поле — `null` |
| `amountToFuturesPrecision(symbol, amount, rounding?)` | `number` | Количество на шаг фьючерсного символа с направлением округления |
| `sizeFuturesOrder(args: SizeFuturesOrderArgs)` / `splitFuturesOrderQty(args: SplitFuturesOrderQtyArgs)` / `assertFuturesSymbolLoaded(args: AssertFuturesSymbolLoadedArgs)` | как `sizeOrder` / `splitOrderQty` / проверка | Делегаты утилит сайзинга без сырого клиента |
