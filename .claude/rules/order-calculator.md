# OrderCalculator — расчёт ордеров

Файл: `src/core/orderCalculator.ts`

Статический класс — все методы `static`. Содержит всю бизнес-логику расчёта ордеров.

## Основные методы

### resolveSymbolsForExchanges

```typescript
static resolveSymbolsForExchanges(
  symbolList: string[],
  exchangeConnectorByName: ExchangeConnectorByName
): SymbolMappingByExchange
```

Создаёт маппинг символов для всех подключённых бирж. Каждый символ проходит через `resolveSymbolWithPrefix()` коннектора. Результат: `Map<ExchangeNameEnum, Map<originalSymbol, resolvedSymbol>>`.

### createOrderAttributesForSymbol

```typescript
static createOrderAttributesForSymbol(args: {
  isLong: boolean;
  exchangeConnectorByName: ExchangeConnectorByName;
  symbolMappingByExchange: SymbolMappingByExchange;
  stopBuyAfterPercent: number; // порог 24h% роста — не покупать если уже вырос больше
  allowedVolumeByExchange: Map<ExchangeNameEnum, number>;
  leverage: number;
}): OrderAttributes[]
```

Для каждого символа на каждой бирже:
1. Получает тикер (futures по умолчанию)
2. Проверяет наличие цены → ошибка "No price data available" если нет
3. Проверяет 24h% рост vs `stopBuyAfterPercent` → ошибка если превышен
4. Рассчитывает объём: `allowedVolumeUsdt / symbolCount / price`
5. Возвращает `OrderAttributes` с заполненными `orderParams`

### enrichWithSpotFallback

```typescript
static enrichWithSpotFallback(args: {
  orderAttributesList: OrderAttributes[];
  exchangeConnectorByName: ExchangeConnectorByName;
  stopBuyAfterPercent: number;
  allowedVolumeByExchange: Map<ExchangeNameEnum, number>;
  leverage: number;
}): OrderAttributes[]
```

Для каждого ордера с ошибкой "No price data available":
- Переключает `marketType` на `Spot`
- Пересчитывает атрибуты по спотовому тикеру
- Если и на споте нет данных — ошибка остаётся

### calculateLimitOrderWithPriceAdjustment

```typescript
static calculateLimitOrderWithPriceAdjustment(args: {
  orderParams: OrderParams;
  priceAdjustmentPercent: number; // +40 для buy, -40 для sell
  orderVolumeUsdt: number;
  leverage?: number;        // по умолчанию 1
  exchangeClient?: ExchangeClient; // опционально: применяет precision биржи
}): OrderParams
```

Корректирует цену на процент и пересчитывает `amount` по новой цене. Для спот-ордеров объём делится на leverage. Если передан `exchangeClient` — применяет `amountToPrecision` и `priceToPrecision` к результирующим `amount` и `price`.

### calculateCloseOrder

```typescript
static calculateCloseOrder(
  orderParams: OrderParams,
  priceShiftPercent: number, // +10 для TP, -5 для SL
  isTakeProfit: boolean
): OrderParams
```

Создаёт обратный ордер (противоположная сторона):
- **Take Profit**: `Limit` ордер, `reduceOnly` для futures
- **Stop Loss**: `Limit` ордер, `reduceOnly` для futures, добавляет `triggerPrice` и `triggerDirection`

### setupLeverageAndMarginModeEnum

```typescript
static setupLeverageAndMarginModeEnum(args: {
  exchangeConnectorByName: ExchangeConnectorByName;
  symbolMappingByExchange: SymbolMappingByExchange;
  leverage: number;
}): Promise<void>
```

Устанавливает `leverage` и `MarginMode.Isolated` для всех символов на всех биржах через `connector.futures.setLeverage()` и `connector.futures.setMarginMode()`. Ошибки логируются, но не прерывают выполнение (silent fail).

## Внутренние методы

- `addPercent(price, percent, isIncrease?)` — сдвиг цены на процент
- `calculateOrderAmount(price, symbolCount, allowedVolumeUsdt)` — распределение объёма
- `resolveOrderSideEnum(isLong)` — `Buy` для long, `Sell` для short
- `calculateAmountForMarketType(args: CalculateAmountForMarketTypeArgs)` — расчёт количества с учётом типа рынка
- `createOrderAttributesForMarketType()` — создание атрибутов для конкретного типа рынка
