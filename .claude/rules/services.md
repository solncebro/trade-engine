# Сервисы

## TelegramNotifier (`src/services/telegramNotifier.ts`)

Telegraf-бот для отправки уведомлений и регистрации команд.

```typescript
class TelegramNotifier {
  constructor(args: { botToken: string; chatId: string })
  registerCommand(config: SpecialCommandConfig): void
  start(): Promise<void>           // запуск с dropPendingUpdates
  sendMessage(message: string, isLogOnly?: boolean): Promise<void>
  sendFormattedMessage(message: string, isLogOnly?: boolean): Promise<void>  // MarkdownV2 с escaping
  sendError(customMessage: string, error: unknown): Promise<void>
  stop(): void
  getChatId(): string
  getBot(): Telegraf
}
```

- Авторизация по chatId (только авторизованный чат)
- `sendMessage` — Markdown parse mode
- `sendFormattedMessage` — MarkdownV2 с автоматическим экранированием через `@solncebro/telegram-engine`
- `sendError` использует `sendFormattedMessage` для отправки ошибок
- Автоматическая настройка menu button со списком команд
- Обёртка обработчиков с try/catch

## TelegramCommandHandler<T> (`src/services/telegramCommandHandler.ts`)

Обработчик команд с типизированными настройками. Generic `<T>` для типа объекта настроек.

```typescript
class TelegramCommandHandler<T> {
  constructor(args: { telegramNotifier: TelegramNotifier; config: TelegramCommandHandlerConfig<T> })
}
```

Регистрирует два типа команд:
- **SpecialCommandConfig** — кастомные команды с произвольными обработчиками
- **Setting команды** — автогенерация из конфигов:
  - Boolean: парсит `yes/no`, `true/false` → вызывает `settingUpdater(key, value)`
  - Numeric: парсит `parseFloat()`, только положительные числа

Имя команды генерируется из ключа: `camelCase` → `SCREAMING_SNAKE_CASE` через `getCommandFromKey()`.

## TelegramMessageListener (`src/services/telegramMessageListener.ts`)

MTProto-клиент для прослушивания сообщений в каналах Telegram.

```typescript
class TelegramMessageListener extends EventEmitter {
  constructor(args: { apiId: number; apiHash: string; appSession: string })
  start(): Promise<void>              // подключение с 5 retry, auth flow
  onMessage(handler: TelegramMessageHandler): void
  removeMessageHandler(handler: TelegramMessageHandler): void
  stop(): void
  getIsConnected(): boolean
}

type TelegramMessageHandler = (message: TelegramIncomingMessage) => void | Promise<void>;
interface TelegramIncomingMessage { chatId: string; senderId: string; message: Api.Message }
```

- Использует `telegram` lib (не Telegraf — это разные вещи)
- `StringSession` для сохранения сессии
- Events: `connected`, `disconnected`, `error`, `message`
- Каждый обработчик изолирован — ошибка в одном не блокирует другие

## FirebaseServiceBase<T> (`src/services/firebaseServiceBase.ts`)

Базовый класс Firestore CRUD с real-time подпиской. Implements `Notifiable`.

```typescript
class FirebaseServiceBase<T> extends EventEmitter implements Notifiable {
  constructor(args: {
    documentPath: string;
    defaultData: T;
    telegramNotifier: TelegramNotifier;
  })
  initialize(): Promise<void>         // init Firebase app + подписка
  getData(): T                        // текущие данные
  updateData(data: Partial<T>): Promise<void>
  getDocumentReference(): DocumentReference
  getFirestore(): Firestore
  getChangedSettings(current: T, previous: T): SettingChange<T[keyof T]>[]
  disconnect(): Promise<void>         // отписка + delete app
  onNotify: Notifiable['onNotify']    // делегирует в telegramNotifier.sendFormattedMessage
  onError: Notifiable['onError']      // делегирует в telegramNotifier.sendError
}
```

- Firebase Admin SDK с credential cert
- Env vars: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- `onSnapshot()` для real-time обновлений
- Данные мержатся с defaults: `{ ...defaultData, ...fetchedData }`
- Event `dataChanged` с `{ current, previous }`
- Сравнение массивов через `JSON.stringify`, примитивов — по значению
- Protected методы для форматирования настроек: `formatSettingMessage()`, `getAddedAndRemovedItemsMessage()`
- Предназначен для наследования — потребители расширяют этот класс
- **3.5.0**: `updateData(data: Partial<T>)` внутренне вызывает `flattenForFirestoreUpdate(data)` — превращает вложенные объекты в dot-notation (`{ a: { b: 1 } }` → `{ "a.b": 1 }`), как требует Firestore `documentReference.update()`. Массивы и примитивы сохраняются как есть.

## KlineSubscriptionWatchdog (`src/services/klineSubscriptionWatchdog.ts`, 3.5.0)

Мониторинг активности kline-подписок с автоматическим восстановлением. Создаётся опционально внутри `ExchangeConnector` через 5-й аргумент конструктора `klineWatchdogConfig`.

```typescript
class KlineSubscriptionWatchdog {
  constructor(args: KlineSubscriptionWatchdogArgs)
  wrapHandler(symbol, interval, userHandler): KlineHandler  // обёртка для трекинга timestamp
  unregisterHandler(symbol, interval): void
  start(): void
  stop(): void
  getDiagnosticInfo(): KlineSubscriptionWatchdogDiagnostic
}

interface KlineSubscriptionWatchdogConfig {
  isEnabled?: boolean;                  // default true
  checkIntervalMs?: number;             // 30_000 — частота сканирования overdue
  graceMs?: number;                     // 60_000 — порог "молчания" подписки
  parallelismLimit?: number;            // 2 — макс. параллельных восстановлений
  restRefetchLimit?: number;            // 100 — fallback REST refetch
  restTimeoutMs?: number;               // 30_000
  heartbeatEveryNTicks?: number;        // 10
  recoveryCooldownMs?: number;          // 120_000
  recoveryFailCooldownMs?: number;      // 600_000
  recoveryFailCountThreshold?: number;  // 3
  restInterCallMs?: number;             // 100
  symbolMarker?: (symbol, interval) => string;
}
```

**Алгоритм восстановления**:
1. `resubscribeKlines(symbol, interval)` — попытка пересоздать поток через WS.
2. Если поток не восстановился (новый kline не пришёл в течение grace) → REST `fetchKlines(symbol, interval, limit=restRefetchLimit)` и replay в user handler.
3. После `recoveryFailCountThreshold` неудач для одной подписки → cooldown `recoveryFailCooldownMs`.

См. `src/services/klineSubscriptionWatchdog.ts`. Использует `subscribeKlines`/`unsubscribeKlines`/`resubscribeKlines`/`fetchKlines` из `ExchangeClient`.

## Binance Spot user-data (exchange-engine 0.14.0, commit `d93c52a`)

Начиная с `exchange-engine` 0.14.0 (commit `d93c52a`), Binance Spot user-data поступает через **WebSocket API** (`BinanceSpotUserDataStream`), а не через listenKey REST (удалён биржей 2026-02-20). Потребитель подписывается через `connector.spot.connectUserDataStream(handler)`. Помимо `onOrderUpdate`/`onPositionUpdate`, доступен опциональный `onBalanceUpdate` (`UserDataStreamHandlerArgs.onBalanceUpdate?`): событие `outboundAccountPosition` маппится в `BalanceUpdateEvent { balanceList: BalanceUpdateItem[]; timestamp }`, где `BalanceUpdateItem = { asset, free, locked }`. Типы `BalanceUpdateEvent`/`BalanceUpdateItem`/`BalanceUpdateHandler` реэкспортируются из `@solncebro/trade-engine`. trade-engine не оборачивает user-data stream — работа идёт напрямую через `connector.spot`/`connector.futures`.

## PremiumIndexCalculator (`src/services/premiumIndexCalculator.ts`)

Поддерживает per-symbol непрерывную EMA «премии» (`midPrice − markPrice`) с окном 30 секунд. Значение используется как `premiumAvg` для `OrderCalculator.calculatePriceLimitBounds` (Bybit-ветка). Bybit не публикует это значение ни на одном публичном WebSocket-стриме для линейных USDT-перпетуалов, поэтому потребитель обязан считать его сам.

```typescript
class PremiumIndexCalculator {
  feed(args: { symbol: string; bidPrice: number; askPrice: number; markPrice: number; timestamp: number }): void
  getPremiumAvg(symbol: string): number | undefined
  clear(): void
}
```

- `midPrice = (bidPrice + askPrice) / 2`, `delta = midPrice − markPrice`.
- EMA в непрерывном времени: `α(Δt) = 1 − exp(−Δt / 30s)`, `ema_new = ema_prev + α × (delta − ema_prev)`. Первый сэмпл инициализирует состояние напрямую (без сглаживания).
- `feed` игнорирует невалидные сэмплы (`bid/ask/mark` не-finite или `<= 0`, `timestamp` не-finite) и неположительные интервалы (`intervalSec <= 0`).
- `getPremiumAvg` возвращает `undefined`, пока по символу не было ни одного валидного сэмпла.
- **НЕ auto-wired.** Потребитель сам инстанцирует калькулятор, кормит его orderbook + mark price через `feed`, и передаёт `getPremiumAvg(symbol)` в `premiumAvg` аргументов `calculatePriceLimitBounds`.

Экспортируется из `@solncebro/trade-engine` (`src/index.ts`).

## ConfigManager (`src/core/config.ts`)

```typescript
class ConfigManager {
  static validateRequiredEnvVars(requiredVarNameList: string[]): void  // throws Error
  static hasValidExchangeCredentials(config: ExchangeConfig): boolean
}
```

## Logger (`src/core/logger.ts`)

```typescript
function createLogger(args?: {
  level?: string;              // по умолчанию из LOG_LEVEL env
  isConsoleEnabled?: boolean;  // true
  isFileEnabled?: boolean;     // false
  filePath?: string;           // ./logs/output.logs
  betterStackToken?: string;
  betterStackEndpoint?: string;
}): Logger

const logger: Logger  // lazy singleton через Proxy
```

Транспорты: console (pino-pretty), file (pino-pretty без цвета), BetterStack (@logtail/pino). BetterStack-транспорт добавляется только если заданы оба значения: `betterStackToken` и `betterStackEndpoint`. Для endpoint поддерживаются и полный URL (`https://...`/`http://...`), и хост без схемы — в этом случае автоматически добавляется `https://`.

Error serializer: `pino.stdSerializers.wrapErrorSerializer` расширяет стандартную сериализацию, сохраняя поля `code` и `exchange` из объекта ошибки.

## Reliability-инфраструктура (3.5.0)

### RateLimitedRequestQueue (`src/core/RateLimitedRequestQueue.ts`)

Sliding-window очередь для контроля RPS write-операций.

```typescript
class RateLimitedRequestQueue {
  constructor(args: { rateLimit: number; intervalMs?: number; loggerLabel?: string })
  execute<T>(fn: () => Promise<T>, contextLabel?: string): Promise<T>
  getRateLimit(): number
  getIntervalMs(): number
}
```

Используется внутри `PositionManager` (все write-операции) и `ExchangeConnector` (динамически создаётся в `initialize()` через `getOrderRateLimit()`). Логирует первый раз, когда срабатывает throttling.

### withRetryOn429 / withReadRetry (`src/core/withRetryOn429.ts`)

Retry на 429 и 5xx с exponential backoff и поддержкой `Retry-After` header.

```typescript
withRetryOn429<T>({ fn, contextLabel, maxRetries?, baseDelayMs? }): Promise<T>
withReadRetry<T>({ fn, contextLabel, maxRetries?, baseDelayMs? }): Promise<T>
```

Defaults: `maxRetries = 3`, `baseDelayMs = 1000`, exponential `delay * 2^(attempt-1)`. Используется:
- `withRetryOn429`: внутри `PositionManager.cancelOrder/cancelBatchOrders/cancelAllOrders/modifyOrder/modifyBatchOrders/setLeverage/setMarginMode`.
- `withReadRetry`: в `ExchangeConnector.initialize()` (loadTradeSymbols) и `updateTickers()` (fetchTickers).

## Утилиты (`src/utils/`)

| Файл | Экспорты |
|------|---------|
| `order.utils.ts` | `isOrderSuccessful(result)`, `isSpot(marketType)` |
| `symbol.utils.ts` | `normalizeSymbol(symbol)` — убирает `/`, `:`, `.`, `-` |
| `date.utils.ts` | `createDate()`, `formatTimestamp()`, `createHumanTimestamp()` |
| `errorFormatter.utils.ts` | `formatErrorMessage(args)` — с error code |
| `readline.utils.ts` | `ReadlineHelper` — stdin/stdout промпт |
| `telegramCommand.utils.ts` | `getCommandFromKey(key)` — camelCase → SCREAMING_SNAKE |
| `websocketEmulator.utils.ts` | Standalone CLI-скрипт, не импортировать |
