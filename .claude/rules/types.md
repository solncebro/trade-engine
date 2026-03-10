# Система типов

Все типы в `src/types/`, реэкспортируются через `src/types/index.ts`.

## Реэкспорты из exchange-engine

Из `@solncebro/exchange-engine` реэкспортируются:
- **Enums**: `ExchangeName`, `MarginMode`, `OrderSide`, `OrderType`, `TimeInForce`, `TradeSymbolType`
- **Types**: `ExchangeClient`, `Position`, `Ticker`, `TickerBySymbol`

## Основные типы

### Рынки и ордера (`orders.ts`)

```typescript
enum MarketType {
  Futures = 'futures',
  Spot = 'spot',
}

interface OrderParams {
  symbol: string;
  side: OrderSide;       // Buy | Sell
  amount: number;
  price: number;
  type: OrderType;       // Market | Limit
  marketType?: MarketType;
  triggerPrice?: number;     // для SL ордеров
  triggerDirection?: 1 | 2;  // 1 = рост, 2 = падение
  params?: Record<string, unknown>; // доп. параметры биржи
}

interface OrderAttributes {
  orderParams: OrderParams;
  exchangeName: ExchangeName;
  errorText?: string;     // ошибка вместо исключения
}

interface OrderResult extends OrderAttributes {
  orderId?: string;
  actualExchangeParams?: ExchangeOrderParams;
  responseData?: ExchangeResponseData;
}

interface CloseOrderResult {
  orderId?: string;
  price?: number;
  errorText?: string;
}
```

### Тайминги

```typescript
interface OrderTiming {
  requestSentAt: number;
  responseReceivedAt: number;
}

interface OrderTimings {
  signalReceivedAt: number;
  entryOrder: OrderTiming;
  takeProfitOrder?: OrderTiming;
  stopLossOrder?: OrderTiming;
  emergencyExitOrder?: OrderTiming;
}

interface SignalExecutionDetails extends OrderResult {
  takeProfitOrderResult?: CloseOrderResult;
  stopLossOrderResult?: CloseOrderResult;
  emergencyExitOrderResult?: CloseOrderResult;
  timings?: OrderTimings;
}
```

### Маппинги

```typescript
type SymbolMappingByExchange = Map<ExchangeName, Map<string, string>>;
// Map<биржа, Map<оригинальный символ, резолвленный символ>>

type ExchangeConnectorByName = Map<ExchangeName, ExchangeConnector>;
```

### Конфигурация (`config.ts`)

```typescript
interface ExchangeConfig {
  apiKey: string;
  secret: string;
  demo?: boolean;  // включить demo trading
}
```

### Биржевые типы (`exchange.ts`)

```typescript
interface ExchangeOrderParams {
  symbol: string;
  side: string;
  amount?: number;
  qty?: string;
  type?: string;
  orderType?: string;
  price?: number | string;
  category?: string;
  timeInForce?: string;
  hedgeMode?: boolean;
  reduceOnly?: boolean;
  params?: Record<string, unknown>;
}

interface ExchangeResponseData {
  id?: string;
  orderId?: string;
  symbol?: string;
  side?: string;
  amount?: number;
  price?: number;
  average?: number;
  timestamp?: number;
  filled?: number;
  remaining?: number;
  cost?: number;
  fee?: { currency?: string; cost?: number };
}
```

### Telegram типы

```typescript
// telegram.ts
interface TelegramNotifierArgs { botToken: string; chatId: string }
interface TelegramMessageListenerArgs { apiId: number; apiHash: string; appSession: string }

// telegramCommandHandler.ts
interface SpecialCommandConfig { command: string; description: string; handler: CommandHandler }
interface BooleanSettingConfig<T> { key: T; label: string; enabledEmoji: string; disabledEmoji: string }
interface NumericSettingConfig<T> { key: T; label: string; suffix: string; emoji: string }
interface TelegramCommandHandlerConfig<T> {
  specialCommandList: SpecialCommandConfig[];
  numericSettingConfigList: NumericSettingConfig<keyof T>[];
  booleanSettingConfigList: BooleanSettingConfig<keyof T>[];
  settingsGetter: () => T;
  settingUpdater: (key: keyof T, value: unknown) => Promise<void>;
}
```

### Firebase типы (`firebase.ts`)

```typescript
type FirebaseStrategySettingsValues = string[] | number | boolean;

interface SettingChange<V> {
  key: string;
  current: V;
  previous: V;
  isChanged: boolean;
}
```

## Проверка результатов

```typescript
// Проверка успешности ордера — НЕ исключения, а проверка orderId
isOrderSuccessful(result: EntityWithOrderId): boolean  // !!result.orderId
isSpot(marketType?: MarketType): boolean               // marketType === Spot
```
