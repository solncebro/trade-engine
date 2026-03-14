# Сервисы

## TelegramNotifier (`src/services/telegramNotifier.ts`)

Telegraf-бот для отправки уведомлений и регистрации команд.

```typescript
class TelegramNotifier {
  constructor(args: { botToken: string; chatId: string })
  registerCommand(config: SpecialCommandConfig): void
  start(): Promise<void>           // запуск с dropPendingUpdates
  sendMessage(message: string, isLogOnly?: boolean): Promise<void>
  sendError(customMessage: string, error: unknown): Promise<void>
  stop(): void
  getChatId(): string
}
```

- Авторизация по chatId (только авторизованный чат)
- Markdown parse mode для сообщений
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

## FirebaseService<T> (`src/services/firebaseService.ts`)

Firestore CRUD с real-time подпиской.

```typescript
class FirebaseService<T> extends EventEmitter {
  constructor(args: {
    documentPath: string;
    defaultData: T;
    onNotify: (message: string) => void | Promise<void>;
    onError: (message: string, error: unknown) => void | Promise<void>;
  })
  initialize(): Promise<void>         // init Firebase app + подписка
  getData(): T                        // текущие данные
  updateData(data: Partial<T>): Promise<void>
  getChangedSettings(current: T, previous: T): SettingChange<T[keyof T]>[]
  disconnect(): Promise<void>         // отписка + delete app
}
```

- Firebase Admin SDK с credential cert
- Env vars: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- `onSnapshot()` для real-time обновлений
- Данные мержатся с defaults: `{ ...defaultData, ...fetchedData }`
- Event `dataChanged` с `{ current, previous }`
- Сравнение массивов через `JSON.stringify`, примитивов — по значению
- Форматирование изменений настроек с emoji и diff

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

Транспорты: console (pino-pretty), file (pino-pretty без цвета), BetterStack (@logtail/pino).

Error serializer: `pino.stdSerializers.wrapErrorSerializer` расширяет стандартную сериализацию, сохраняя поля `code` и `exchange` из объекта ошибки.

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
