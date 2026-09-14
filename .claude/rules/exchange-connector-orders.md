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
- **timeInForce.** Все биржи: `IOC` для Market, `GTC` для Limit-like (в т.ч. `StopLimit`/`TakeProfitLimit` на spot).
- **Stop Loss.** `triggerPrice` (через `stopPrice`) и `triggerDirection` если указаны.

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
| `readPositionState(args: ReadPositionStateArgs)` | `Promise<PositionStateResult>` | **Только futures** (иначе throws). Возвращает discriminated union: `{ kind: 'present', position }` / `{ kind: 'absent', confidence, reason }` / `{ kind: 'ambiguous', reason, position }`. Учитывает Hedge/OneWay (`positionIdx`, `side`) |
| `readAllPositions(args: ReadAllPositionsArgs)` | `Promise<Position[]>` | **Только futures** (иначе throws). `connector.futures.fetchAllPositions()`; при ошибке re-throws |

- `OpenPositionBatchLimitResult` / `ClosePositionBatchLimitResult` = `PositionBatchLimitItemResult[]`, где `PositionBatchLimitItemResult = { isSuccess, orderId: string | null, errorText: string | null }`.
- `PositionStateResult` reasons: `PositionAbsenceReason = 'no_record' | 'zero_contracts' | 'fetch_error'`, `PositionAmbiguityReason = 'side_mismatch' | 'idx_mismatch'`.
