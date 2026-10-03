# Сервисы

## Telegram — только через `@solncebro/telegram-engine` (3.24.0)

Своих реализаций Telegram в пакете нет: доступ, рассылка, бот, разбор аргументов команд и клиент
пользователя — детали telegram-engine (>= 0.6.0). Прямые импорты `telegraf` / `telegram` запрещены
(обе библиотеки даже не объявлены в зависимостях — приходят через telegram-engine); типы `Context`,
`Telegraf` — `import type { Context, Telegraf } from '@solncebro/telegram-engine'`.

## TelegramNotifier (`src/services/telegramNotifier.ts`)

Бот уведомлений и команд, собранный из деталей telegram-engine.

```typescript
class TelegramNotifier {
  constructor(args: { botToken: string; chatId: string | string[] })  // один чат или список для рассылки
  registerCommand(config: SpecialCommandConfig): void
  start(): Promise<void>           // меню команд (setMyCommands), затем bot.launch({ dropPendingUpdates: true })
  sendMessage(message: string, isLogOnly?: boolean): Promise<void>
  sendFormattedMessage(message: string, isLogOnly?: boolean): Promise<void>  // MarkdownV2 с escaping
  sendError(customMessage: string, error: unknown): Promise<void>
  stop(): void
  getChatId(): string              // главный (первый) чат — back-compat
  getChatIdList(): string[]        // все чаты рассылки
  getBot(): Telegraf
}
```

- **Multi-chat рассылка.** `chatId` принимает строку ИЛИ массив строк. Список нормализуется (trim + отброс пустых; нужен ≥1, иначе конструктор бросает). Все `sendMessage`/`sendFormattedMessage`/`sendError` **рассылаются в каждый чат**; одиночная строка = список из одного (полная обратная совместимость).
- **Детали telegram-engine:** `createBot` (сторож падений: один упавший обработчик не останавливает опрос, в чат уходит короткое «⚠️ Oops …»), `createSender` + `createBroadcaster` + `createReporter` (рассылка с изоляцией по чатам; `reportEvent(текст, true)`), `createAccessControl({ allowedPeerList: chatIdList, shouldAllowAllWhenEmpty: false })` + `createAccessGuard` (доступ к командам; чужой чат — один раз предупреждение в лог, ответа нет), `stop()` экземпляра `createBot`.
- Формат единый — MarkdownV2 через `escapeMarkdownV2WithFormatting`: и `sendMessage`, и `sendFormattedMessage` экранируют и шлют V2. `sendError` — «❌ APPLICATION ERROR:\n<текст>\n\n<сообщение>\n\nStack:\n<стек>» через `sendFormattedMessage`.
- `registerCommand` регистрирует обработчик СРАЗУ (`bot.command(имя, accessGuard.middleware, обработчик)`), а не в `start()`: место команды в цепочке относительно обработчиков приложения (`getBot().on(...)`) не меняется, поздняя регистрация работает. Ошибка обработчика → ответ «❌ Command <имя> failed» + лог.
- `registerBotCommands` из telegram-engine НЕ используется намеренно: регистрирует весь список разом и ставит свой `bot.catch`, который затирает сторож падений `createBot`.
- `launch` экземпляра `createBot` не используется: он не передаёт `dropPendingUpdates`, а бот после перезапуска не должен исполнять накопившиеся нажатия. Отказ опроса (409 при перекрытии перезапусков) пишется в лог, не всплывает.
- `stop()` незапущенного бота не бросает — предупреждение «Telegram bot stop failed» в лог.
- Поведение закреплено `tests/telegramNotifierBehaviour.test.ts` (написан до перевода на telegram-engine).

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
  - Boolean: `parseYesNoArgument` из telegram-engine (`yes/no`, `true/false`, без учёта регистра) → `settingUpdater(key, value)`
  - Numeric: `parseFloat()` + `validatePositiveNumber` из telegram-engine, только положительные числа

Аргумент — слово сразу после команды при делении по одиночному пробелу (двойной пробел → пустой аргумент → ответ «❌ Usage: …»).
Имя команды — `buildCommandNameFromKey` из telegram-engine: `camelCase` → `snake_case` (`maxOrderUsd` → `max_order_usd`). `getCommandFromKey()` (`src/utils/telegramCommand.utils.ts`) оставлен для совместимости и отдаёт работу ему. Поведение закреплено `tests/telegramCommandHandler.test.ts`.

## TelegramMessageListener (`src/services/telegramMessageListener.ts`) — устаревший

Тонкая обёртка над `createUserClient` из telegram-engine с прежними именами. Новый код — сам
`createUserClient` (альбомы, правки, удаления, история, приглашения, сторож связи).

```typescript
class TelegramMessageListener extends EventEmitter {
  constructor(args: { apiId: number; apiHash: string; appSession: string })
  start(): Promise<void>              // userClient.start() (вход через stdin, если сессии нет), подписка, событие connected
  onMessage(handler: TelegramMessageHandler): void
  removeMessageHandler(handler: TelegramMessageHandler): void
  stop(): void                        // отписка, userClient.stop() в фоне, событие disconnected
  getIsConnected(): boolean           // запущен И клиент на связи (сторож связи telegram-engine)
}

type TelegramMessageHandler = (message: TelegramIncomingMessage) => void | Promise<void>;
interface TelegramIncomingMessage { chatId: string; senderId: string; message: TelegramUserMessage['raw'] }  // Api.Message
```

- `albumWaitMs: 0` и раздача `partList` по одной части: каждая часть альбома — отдельное сообщение, как до перевода.
- Сообщение без отправителя пропускается (как раньше). Events: `connected`, `disconnected`, `error`, `message`.
- Новая сессия после интерактивного входа пишется в лог (как раньше) — иначе вход бесполезен.
- Каждый обработчик изолирован — ошибка в одном не блокирует другие.

## FirebaseServiceBase<T> (`src/services/firebaseServiceBase.ts`)

Базовый класс Firestore CRUD с real-time подпиской. Implements `Notifiable`.

```typescript
class FirebaseServiceBase<T> extends EventEmitter implements Notifiable {
  constructor(args: {
    documentPath: string;
    defaultData: T;
    telegramNotifier?: TelegramNotifier;          // или onNotify/onError; без обоих — только лог
    onNotify?: Notifiable['onNotify'];
    onError?: Notifiable['onError'];
    resubscribeInitialDelayMs?: number;           // 1000, удваивается до resubscribeMaxDelayMs
    resubscribeMaxDelayMs?: number;               // 60000
    snapshotWatchdogIntervalMs?: number | null;   // null — сторож выключен
    snapshotCacheFilePath?: string | null;        // копия документа на диске; null — старт без Firestore падает
    connectionRetryIntervalMs?: number;           // 30000 — повтор подключения после старта с диска
    initialReadTimeoutMs?: number;                // 30000 — только при заданной копии на диске
    isWriteVisibleImmediately?: boolean;          // true
    pendingWriteMaxAgeMs?: number;                // 15000
  })
  initialize(): Promise<void>         // init Firebase app + создание/дозаполнение документа defaults + подписка
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
- Credentials (только если приложение ещё не вызвало `initializeApp`): если задана `FIREBASE_SERVICE_ACCOUNT_PATH` — учётные данные читаются из этого service-account JSON-файла (`admin.credential.cert(path)`); иначе fallback на три отдельные переменные `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`. Это позволяет приложению не держать `firebase-admin` в своих зависимостях — инициализация и доступ к Firestore (`getFirestore()`) полностью на стороне базового класса.
- `onSnapshot()` для real-time обновлений
- **Самозаполнение defaults при `initialize()`:**
  - документа нет → создаётся целиком через `documentReference.set(defaultData)`;
  - документ есть → дописываются (`documentReference.update()` в dot-notation) **только отсутствующие** ключи defaults; существующие значения пользователя НИКОГДА не перетираются. Вложенные пропуски (`nested.y`) дозаполняются без затирания соседей (`nested.x`). Если ничего не пропущено — записи в Firestore нет.
  - Расчёт пропусков — `collectMissingDefaults(defaults, stored)` (рекурсивно), затем `flattenForFirestoreUpdate` в dot-notation. `updateData` использует `update()` и требует существующий документ — поэтому первичное создание возможно только через ветку `set()`.
- Данные мержатся с defaults: `{ ...defaultData, ...fetchedData }`
- Event `dataChanged` с `{ current, previous }`
- Сравнение массивов через `JSON.stringify`, примитивов — по значению
- Protected методы для форматирования настроек: `formatSettingMessage()`, `getAddedAndRemovedItemsMessage()`
- Предназначен для наследования — потребители расширяют этот класс
- **3.5.0**: `updateData(data: Partial<T>)` внутренне вызывает `flattenForFirestoreUpdate(data)` — превращает вложенные объекты в dot-notation (`{ a: { b: 1 } }` → `{ "a.b": 1 }`), как требует Firestore `documentReference.update()`. Массивы и примитивы сохраняются как есть.
- **Живучесть подписки (3.24.0).** Ошибка `onSnapshot` (Firestore после неё больше не присылает ничего) →
  событие `connectionLost { reason: 'listenerError' }`, переоткрытие подписки с паузой 1 с, 2 с, 4 с … 60 с;
  первый снимок после переоткрытия → `connectionRestored`, пауза сбрасывается. `isConnected()` — текущее состояние.
- **Сторож снимка (3.24.0).** При `snapshotWatchdogIntervalMs` раз в интервал `checkSnapshotFreshness()` перечитывает
  документ и сравнивает с копией в памяти (с сортировкой ключей). Расхождение → копия чинится, `dataChanged` +
  `snapshotDiverged { divergentKeyList, current, previous }`, подписка переоткрывается, одно уведомление на
  эпизод. Неудачное перечитывание → `connectionLost { reason: 'watchdogReadFailed' }`, удачное → `connectionRestored`.
  Изменение, пришедшее между чтением сторожа и собственным снимком, может один раз выглядеть как расхождение —
  тогда «починка» просто раньше времени кладёт те же данные.
- **Копия на диске (3.24.0).** При `snapshotCacheFilePath` каждый новый снимок пишется в JSON-файл (временный файл +
  переименование). Firestore недоступен при `initialize()` (или чтение дольше `initialReadTimeoutMs`) →
  старт с копии: `startedFromDiskCopy { savedAtMs, error }`, `connectionLost { reason: 'initialReadFailed' }`,
  уведомление через `onError`, повтор подключения каждые `connectionRetryIntervalMs`; удача → `connectionRestored`,
  `dataChanged` если данные отличаются. Копия другого документа (не совпал `documentPath`) не принимается. Без
  копии — прежнее поведение: `onError` и исключение. Копия хранит JSON: для документов с датами Firestore
  (`Timestamp`) восстановленные значения будут простыми объектами.
- **Записанное видно сразу (3.24.0).** После подтверждённого `updateData` значения по их путям (как у Firestore
  `update`) накладываются в `getData()` до прихода эха; путь снимается, как только снимок принёс то же
  значение, или через `pendingWriteMaxAgeMs`. Отклонённая запись ничего не меняет. `FieldValue`-метки не
  накладываются.
- **Соседние документы и карты элементов (3.24.0).** `readSiblingDocument/writeSiblingDocument(name)` — документ в той же
  коллекции. `setMapItem/updateMapItem/removeMapItem(location, itemId, ...)` — элемент карты; `location` —
  строка (поле этого документа, путь через точку) или `{ siblingDocumentName, mapField? }` (без `mapField` —
  верхние поля соседнего документа, как chasers в ma-chaser). `setMapItem` заменяет элемент целиком (`mergeFields`)
  и создаёт недостающий документ; `updateMapItem`/`removeMapItem` требуют существующий документ. Ошибки
  пишутся в лог и пробрасываются (как у `updateData`). Имена событий — `FIREBASE_SERVICE_EVENT`.

## PersistedListDocument<TRecord> (`src/services/persistedListDocument.ts`, 3.24.0)

Список записей по ключу в памяти (истина, пока процесс жив) + фоновое зеркало в один документ `{ recordList, updatedAtMs }`. Аргументы: `io` (`read`/`write` по имени; `null` — только память), `documentName`, `logger` (`warn`/`error`), `logLabel`, `keyOf`, `parse` (`null` — запись выброшена с ошибкой в лог), `serialize`, необязательные `selectDropped` (что выбросить после `set` и после слияния — например всё, кроме новейших 20; это не «забывание») и `retryMs` (30 000).
- Отказ чтения — «ничего не помним», без исключения; содержимое документа неизвестно → записи придерживаются до удачного перечитывания. Нет документа или нет списка — известно пустой.
- Позднее чтение СЛИВАЕТ документ с памятью, память главнее; ключи, удалённые (`remove`/`clear`) пока документ был непрочитан, не воскресают; этот список очищается первой удачной записью.
- Запись фоном: одна в полёте, залп изменений — ровно одна следующая запись с последним состоянием. Неудача чтения или записи — повтор через `retryMs` на таймере с `unref`.
- `flush()` дожидается записи в полёте и форсирует задолженную (при непрочитанном документе — ещё одна попытка чтения; не вышло — не пишет и пишет ошибку в лог).
- `get`/`list` отдают сами хранимые объекты — хранилище с изменяемыми записями копирует их на своей границе.

## KlineSubscriptionWatchdog (`src/services/klineSubscriptionWatchdog.ts`, 3.5.0; с 3.22.0 — обёртка)

Мониторинг активности kline-подписок с автоматическим восстановлением. Создаётся опционально внутри `ExchangeConnector` через 5-й аргумент конструктора `klineWatchdogConfig`. **С 3.22.0 это тонкая обёртка** над общим `StreamSubscriptionWatchdog` и `KlineWatchdogStrategy` (`src/services/klineWatchdogStrategy.ts`): интерфейс ниже прежний, вся машинерия сканирования/восстановления/подавления — общая с потоками стакана, сделок и mark-цены (`.claude/rules/exchange-connector-streams.md`, «Stream Subscription Watchdog»).

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
1. На весь круг просроченных подписок — одна пакетная команда `resubscribeKlineList(...)` (не по вызову на каждую пару символ+таймфрейм — иначе биржа рвёт соединение при массовой просрочке, см. `CHANGELOG.md`).
2. Если поток всё равно не восстановился (новый kline не пришёл в течение grace) → REST `fetchKlines(symbol, interval, limit=restRefetchLimit)` и replay в user handler.
3. После `recoveryFailCountThreshold` неудач для одной подписки → cooldown `recoveryFailCooldownMs`.

См. `src/services/klineSubscriptionWatchdog.ts` (обёртка) и `src/services/klineWatchdogStrategy.ts` (логика). Использует `resubscribeKlineList`/`fetchKlines` из `ExchangeClient`; `subscribeKlines`/`unsubscribeKlines` оборачивает прокси `ExchangeConnector`.

## Утилиты паузы и таймаута

`sleep(ms)` (`src/utils/sleep.ts`, 3.22.0) и `withTimeout(promise, ms, message)` (`src/utils/timeout.ts`) экспортируются из пакета — приложениям своих копий не заводить (в 3.22.0 вычищены пять копий `sleep` и вторая `withTimeout` внутри самой библиотеки).

## Binance Spot user-data (exchange-engine 0.14.0, commit `d93c52a`)

Начиная с `exchange-engine` 0.14.0 (commit `d93c52a`), Binance Spot user-data поступает через **WebSocket API** (`BinanceSpotUserDataStream`), а не через listenKey REST (удалён биржей 2026-02-20). Потребитель подписывается через `connector.spot.connectUserDataStream(handler)`. Помимо `onOrderUpdate`/`onPositionUpdate`, доступен опциональный `onBalanceUpdate` (`UserDataStreamHandlerArgs.onBalanceUpdate?`): событие `outboundAccountPosition` маппится в `BalanceUpdateEvent { balanceList: BalanceUpdateItem[]; timestamp }`, где `BalanceUpdateItem = { asset, free, locked }`. Типы `BalanceUpdateEvent`/`BalanceUpdateItem`/`BalanceUpdateHandler` реэкспортируются из `@solncebro/trade-engine`. trade-engine не оборачивает user-data stream — работа идёт напрямую через `connector.spot`/`connector.futures`.

## PremiumIndexCalculator (`src/services/premiumIndexCalculator.ts`)

Поддерживает per-symbol непрерывную EMA «премии» (`midPrice − markPrice`) с окном 30 секунд. Bybit не публикует это значение ни на одном публичном WebSocket-стриме для линейных USDT-перпетуалов, поэтому потребитель обязан считать его сам — этот класс и есть общее место, где оно считается. Значение забирается через `getPremiumAvg`; расчёта ценовых границ в библиотеке нет (ушёл вместе с `OrderCalculator` в 3.13.0), и в саму формулу границ «премия» больше не входит — см. `types.md`, раздел про ценовые лимиты.

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
- **НЕ auto-wired.** Потребитель сам заводит калькулятор, кормит его стаканом и ценой маркировки через `feed` и сам решает, куда девать `getPremiumAvg(symbol)`. В расчёт ценовых границ это значение больше не идёт: сам расчёт из библиотеки ушёл, а в официальной формуле Bybit слагаемого «премии» нет — самодельная добавка раздувала полосу ровно на прижатых разгонах (`src/types/priceLimit.ts`).

Экспортируется из `@solncebro/trade-engine` (`src/index.ts`).

## TradifiSymbolGate (`src/services/tradifiSymbolGate.ts`, 3.12.0)

Переиспользуемый хранитель «универса без TradFi» (токенизированные акции/ETF/сырьё). Загружает список фьючерсов через `connector.getFuturesSymbols({ excludeTradifi })`, отвечает `isAllowed(symbol)`, классифицирует незнакомый символ через `classify(symbol)` (одна общая перезагрузка кэша символов на всех одновременных новичков — кулдаун коннектора бережёт REST; отрицательный вердикт помнится час через `BLOCKED_CLASSIFICATION_TTL_MS`).

```typescript
class TradifiSymbolGate {
  constructor(args: { connector: TradifiSymbolGateConnector; shouldAllowTradifi?: boolean })  // default false
  initialize(): Promise<void>              // грузит универс, throws если пусто
  loadUniverse(): Promise<string[]>        // читает кэш коннектора без REST-обновления
  reloadUniverse(): Promise<string[]>      // refreshFuturesTradeSymbols() + loadUniverse()
  isAllowed(symbol): boolean
  isBlocked(symbol): boolean
  classify(symbol): Promise<boolean>
  classifyInBackground(symbol): void
  getAllowedSymbolList(): string[]
  filterSymbolList(symbolList): string[]
}
```

- **`shouldAllowTradifi`** (3.13.0, опционально, default `false`): при `false` (как раньше) вызывает `getFuturesSymbols({ excludeTradifi: true })` — TradFi отфильтрован. При `true` вызывает `getFuturesSymbols({ excludeTradifi: false })` — фильтр снят, TradFi-символы допускаются в `isAllowed`/`classify`/`filterSymbolList`. Приложение должно явно передать `true`, чтобы изменить поведение.
- Потребители: `market-data-feeder` (универс фида) и `rubber` (собственный фильтр входящего фида — вторая линия защиты).

Экспортируется из `@solncebro/trade-engine` (`src/index.ts`): `TradifiSymbolGate`, `TradifiSymbolGateArgs`, `TradifiSymbolGateConnector`.

## ConfigManager (`src/core/config.ts`)

```typescript
class ConfigManager {
  static validateRequiredEnvVars(requiredVarNameList: string[]): void  // throws Error
  static hasValidExchangeCredentials(config: ExchangeConfig): boolean
}
```

## Чтение окружения (`src/core/envReaders.ts`, 3.24.0)

`readPositiveNumber(name, fallback)`, `readOptionalString(name)` (null вместо пустой строки),
`readEnum(name, allowedValueList, fallback)`, `readBoolean(name, fallback)` (true/false, 1/0, yes/no, on/off),
`parseChatIdList(raw, varName = 'TELEGRAM_ALLOWED_CHAT_IDS')`. Не задано / пусто → значение по умолчанию;
неверное значение → исключение с именем переменной (запуск на числе, которого оператор не выбирал, хуже отказа).

## Supabase Storage (`src/services/supabase/supabaseStorage.ts`, 3.24.0)

`createSupabaseServiceClient({ url, serviceKey })` — единственный способ создать серверный клиент (им пользуется
журнал). `uploadFileToStorage({ client, bucket, path, content, contentType, isUpsert, signedUrlExpiresInSeconds?,
maxRetries?, retryBaseDelayMs? })` → `{ isUploaded: true, path, fullPath, publicUrl, signedUrl }` или
`{ isUploaded: false, errorText }`; повтор через `withResultRetry`, исключения не бросаются. `publicUrl` строится
локально и открывается только у публичной корзины. Для всего, что повторяется, `isUpsert: true`: при потерянном
ответе повтор без него получит отказ «уже существует».

## Субсчета (`src/services/subAccountGateway.ts`, 3.24.0)

`connector.subAccounts` — `SubAccountGateway` поверх `Exchange.subAccount` нижней библиотеки (ключ главного счёта),
один на коннектор, ленивый.

```typescript
class SubAccountGateway {
  listSubAccounts(): Promise<SubAccountListResult>                          // { isSuccess: true, subAccountList }
  transferToSubAccount(request: SubAccountTransferRequest): Promise<SubAccountTransferOutcome>    // главный → субсчёт
  transferFromSubAccount(request: SubAccountTransferRequest): Promise<SubAccountTransferOutcome>  // субсчёт → главный
  fetchTransferStatus({ subAccountId, direction, transferId }): Promise<SubAccountTransferStatusResult>  // transfer | null
  fetchSubAccountBalanceList({ subAccountId, walletType }): Promise<SubAccountBalanceListResult>
}
// SubAccountTransferRequest: { subAccountId, asset, amount, fromWalletType, toWalletType, transferId }
// отказ: { isSuccess: false, errorText, errorCode: number | string | null, isNotSupported }
```

- Ничего не бросается; `errorText` — слова биржи (`describeExchangeRefusal`), `errorCode` — код биржи или нижней
  библиотеки (`INVALID_TRANSFER_AMOUNT`, `INVALID_TRANSFER_ID`, `INVALID_SUB_ACCOUNT_ID`, `WALLET_TYPE_NOT_SUPPORTED`,
  `NOT_MASTER_ACCOUNT_KEY`, `SUB_ACCOUNT_NOT_SUPPORTED`).
- Чтения — через `withRetryOn429`. Перевод НЕ повторяется никогда (ни 429, ни 5xx): потерянный ответ не говорит, ушли
  ли деньги; вызывающий хранит свой `transferId` (UUID) и спрашивает `fetchTransferStatus`.
- Демо-режим и OKX: нижняя библиотека отказывает без выхода в сеть (`SUB_ACCOUNT_NOT_SUPPORTED`) → `isNotSupported: true`,
  в лог — предупреждение, а не ошибка.
- `subAccountId`: Binance — почта субсчёта, Bybit — UID строкой.
- `readCapitalBase({ masterClient: connector.futures, subAccountGateway: connector.subAccounts, subAccountIdList, asset?, walletType? })`
  (`src/utils/capitalBase.ts`) — «база капитала = главный + все субсчета»: реализованный (кошельковый) остаток
  монеты (USDT) по всем счетам по очереди. Главный: `balanceByAsset.get(asset)` → `walletBalance ?? total` (Bybit
  заполняет `walletBalance`, у Binance фьючерсов кошельковый остаток лежит в `total`); субсчёт: `walletBalance`
  монеты из `fetchSubAccountBalanceList` (по умолчанию `WalletTypeEnum.UsdtFutures`). Нет монеты — ноль; хоть один
  счёт не прочитан → `totalWalletBalance: null` (частичная сумма занизила бы всё, что от неё считается).

## UserDataStreamRouter (`src/services/userDataStreamRouter.ts`, 3.24.0)

Одно подключение личного потока, раздача подписчикам. Ошибка/отказ обещания одного подписчика — в лог с его
именем, остальные получают событие. Обрыв → всем `onConnectionLost`; возврат → `onConnectionRestored`, затем
`onResyncRequired`. `connect()` один на всех (повторные и одновременные вызовы делят его; упавший можно повторить).
Типы — `UserDataStreamHandlerArgs` нижней библиотеки 0.26.0 (обрыв/возврат потока там объявлены);
`UserDataStreamClient = Pick<ExchangeClient, 'connectUserDataStream' | 'disconnectUserDataStream'>`.

## Плечо и баланс (`src/utils`, 3.24.0)

- `leverageFit.ts` — `fitLeverage` (перенос из rubber): плечо под потолок ступени и свободную маржу.
- `liquidationLeverage.ts` — `estimateIsolatedLiquidationPrice`, `computeMaxLeverageBeforeStop`,
  `resolveEntryLeverage`. Формула: лонг `EP × (1 − 1/L) / (1 − MMR)`, шорт `EP × (1 + 1/L) / (1 + MMR)` —
  опубликованные формулы Binance/Bybit для изолированной маржи с вычетом обслуживающей маржи = 0 (это только
  отодвигает ликвидацию — безопасная сторона), без комиссий (они придвигают ликвидацию — покрывает запас
  `liquidationBufferPercent`). Обслуживающая маржа — в процентах; при ступенях и явном числе берётся бОльшая.
- `accountBalance.ts` — `readAccountBalance`, `readFreeMarginUsd`, `readSpotQuoteBalance`: `null` = не прочитано.
- `capitalBase.ts` — `readCapitalBase` (см. «Субсчета»).
- `breakevenLadder.ts` — плюс `computeBreakevenWithFees`.

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

## PersistentTradeJournal (`src/services/tradeJournal/persistentTradeJournal.ts`, 3.10.0)

Обобщённый буферизованный журнал сделок. Владеет клиентами Supabase и Google Sheets; проект-потребитель описывает только структуру таблиц через `TradeJournalSchema` (имена таблиц `trades`/`events`/`paperState`, `summaryKeyColumn`, `statusColumn`, `terminalStatusList`, `modeColumn`, `reconcileTimeColumn` + `reconcileTimeIsIsoString`, `updatedAtColumn`, `paperStateKeyColumn`, списки колонок/дат/процентов для зеркала, `event.{tradeKeyColumn, seqColumn}`, опционально `sheetOrderColumn`, 3.20.0) и передаёт данные строками `Record<string, unknown>`.

```ts
class PersistentTradeJournal {
  constructor(config: PersistentTradeJournalConfig)   // schema + supabase/sheets creds + flushIntervalMs?/sheetSyncDebounceMs?/liveSheetMirror?
  initialize(): Promise<void>                          // Sheets header/format + flush timer
  isEnabled(): boolean
  putSummary(id, row): void                            // create/replace RAM summary, mark dirty
  patchSummary(id, partialRow): void                   // merge fields (+updatedAt), scream on unknown id
  enqueueEvent(tradeId, eventRow): void                // batched insert; auto seq when schema.event.seqColumn
  flushSummaryNow(id): Promise<boolean>                // immediate single upsert; false when no RAM summary
  rehydrateSummaries(ids): Promise<void>               // reload summaries into RAM after restart
  markOrphaned(args: MarkOrphanedArgs): Promise<void>
  savePaperState(row) / loadPaperStateList() / removePaperState(key)
  reconcileSheetsFromSupabase(lookbackDays) / fullSyncToSheet()
  insertRow(table, row) / updateRows(args) / selectRows(args)   // generic auxiliary-table access with retries; args.range?/order? — 3.20.0
  getSupabaseClient(): SupabaseClient | null           // клиент журнала — для Storage и прочих таблиц (3.24.0)
  replaceNamedSheet(sheetName, rowList): Promise<boolean>  // целиком переписать лист готовой таблицей («Сводка», 3.24.0)
  shutdown(): Promise<void>
}
```

Надёжность: сводки и события копятся в RAM и сливаются пачками (`flushIntervalMs`, дефолт 3с); при сбое БД **только неудавшаяся часть** возвращается в очередь (раздельно сводки/события — без дублей событий), следующий тик повторяет. Терминальные сводки (`statusColumn` ∈ `terminalStatusList`) выгружаются из RAM после успешного слива. Зеркало в Sheets: живой слив с антидребезгом (`liveSheetMirror`) и/или периодическая пересинхронизация из Supabase. Все каналы опциональны (null-креды → канал выключен). Зависит от `@supabase/supabase-js`, `@googleapis/sheets`. Единственная точка взаимодействия с Supabase/Sheets — проекты (rubber и др.) прямых зависимостей не держат.

**`selectRows` — диапазон и сортировка (3.20.0).** `JournalSelectRowsArgs.range?: JournalSelectRangeArgs` — полуоткрытый отрезок по одной колонке (`fromValue` включительно, `toValue` не включительно, `toValue` можно не задавать); `order?: { column, ascending }` — сортировка результата. Оба поля опциональны и накладываются поверх точного совпадения по `match`, без них поведение не меняется.

**Файл-запас на диске (`spoolFilePath`, 3.24.0).** Без него — прежнее поведение (сводки при сбое возвращаются в
очередь в памяти, события после всех повторов выбрасываются). С ним — неудавшиеся сводки и события дописываются
в JSONL-файл (`src/services/tradeJournal/journalSpool.ts`, наружу не экспортируется) и в памяти не перезапрашиваются; досылка — при
`initialize()` и после каждого удачного слива, пока файл не пуст. Досылка: сводки одной пачкой upsert по ключу
(версия из памяти важнее файловой), затем события по порядку файла, кроме уже лежащих в базе (выборка по
`tradeKeyColumn` + `seqColumn`; без `seqColumn` узнать их нельзя — досылаются все). Всё подтверждено → файл
удаляется; не прошли только события → файл атомарно переписывается одними событиями. Порванная последняя строка
(падение посреди записи) пропускается с предупреждением. При старте счётчики `seq` продолжаются с максимума в
файле, `rehydrateSummaries` предпочитает файловую версию сводки базовой и поднимает сводки, которых в базе нет.
Если отказал и диск — прежнее поведение (сводки в память, события теряются, ошибка в лог). Порядок событий
одной сделки между пачками держит колонка `seq`, а не момент вставки. Сливы, досылки и остановка выполняются
строго по одному.

**Именованные листы (`sheetTargetList`, 3.24.0).** `JournalSheetTarget { sheetName, shouldIncludeRow(row) }`.
Живое зеркало и сверка пишут в каждый лист подходящие ему строки (лист без подходящих строк пропускается);
полная перезапись переписывает каждый лист, и пустой тоже (так с него исчезают устаревшие строки). При
`initialize()` заголовок и формат дат готовятся на каждом листе; недостающий лист создаётся (`addSheet`). Без
списка — первый лист, как раньше. Отдельно — `replaceSheetValues(args)` (`sheetsSync.ts`): целиком переписать лист.

**`sheetOrderColumn` (3.20.0, опционально в `TradeJournalSchema`).** Колонка, по которой `fullSyncToSheet` и `reconcileSheetsFromSupabase` упорядочивают строки при записи в Sheets. Лист читает человек сверху вниз, поэтому порядок должен нести смысл для него (например, момент открытия сделки), а не момент последнего обновления строки. Не задано — используется прежний `reconcileTimeColumn`.

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

### withRetryOn429 / withResultRetry (`src/core/withRetryOn429.ts`)

Retry на 429 и 5xx с exponential backoff и поддержкой `Retry-After` header.

```typescript
withRetryOn429<T>({ fn, contextLabel, maxRetries?, baseDelayMs? }): Promise<T>
```

Defaults: `maxRetries = 3`, `baseDelayMs = 1000`, exponential `delay * 2^(attempt-1)`. Используется:
- `withRetryOn429`: внутри `PositionManager.cancelOrder/cancelBatchOrders/cancelAllOrders/modifyOrder/modifyBatchOrders/setLeverage/setMarginMode/setPositionMode/readPositionMode` (3.24.0).
- Читающие вызовы `ExchangeConnector` (`initialize()` — loadTradeSymbols, `updateTickers()` — fetchTickers, `fetchOrderBook`) — тот же `withRetryOn429`; отдельный `withReadRetry` удалён в 3.22.0 как побайтовый дубль.

## Утилиты (`src/utils/`)

| Файл | Экспорты |
|------|---------|
| `priceFormat.ts` (3.17.0) | **`formatPrice(symbol, price)`**, `snapPriceToTick(symbol, price, rounding?)`, `configurePriceTickSnapper(snapper)`, `trimNumberTail(value, maxDigits)` — ⛔️ ОБЯЗАТЕЛЬНАЯ дверь для любой цены наружу, см. ниже (`isPriceTickSnapperConfigured()` удалена в 3.22.0 — не использовалась) |
| `numberFormat.ts` (3.23.0) | **`formatAmount(symbol, amount)`**, `snapAmountToStep(symbol, amount, rounding?)`, `formatUsdAmount(value)`, `roundUsdAmount(value)`, `formatPercent(value, maxDigits?)`, `roundPercent(value, maxDigits?)`, `configureAmountStepSnapper(snapper)` — та же обязательная дверь, но для любого другого вычисленного числа, см. ниже |
| `order.utils.ts` | `isOrderSuccessful(result)`, `isSpot(marketType)` |
| `symbol.utils.ts` | `normalizeSymbol(symbol)` — убирает `/`, `:`, `.`, `-`; `parseRawSymbolInput(raw)` (3.24.0) — ввод человека/сигнала → `PEPEUSDT`, пусто → null |
| `date.utils.ts` | `createDate()`, `formatTimestamp()`, `createHumanTimestamp()` |
| `errorFormatter.utils.ts` | `formatErrorMessage(args)` — с error code |
| `readline.utils.ts` | `ReadlineHelper` — stdin/stdout промпт |
| `telegramCommand.utils.ts` | `getCommandFromKey(key)` — camelCase → snake_case; устаревший, отдаёт работу `buildCommandNameFromKey` из telegram-engine |
| `orderRejection.utils.ts` (3.24.0) | `isPostOnlyRejection({ errorCode?, rejectReason? })` — отказ «только в стакан» (Binance фьючерсы -5022, Bybit `EC_PostOnlyWillTakeLiquidity`) |
| `sequentialQueue.ts` (3.24.0) | `createSequentialQueue({ label, logger?, beforeTask?, slowTaskLogMs? })` → `{ enqueue, drain, size }` — фоновая очередь строго по порядку; ошибка задачи пишется в лог и не останавливает очередь; в отличие от `PerKeySerializer` вызывающий задачу не ждёт |
| `alignedScheduler.ts` (3.24.0) | `startAlignedScheduler({ tickHandler, periodMs, leadMs, errorHandler?, contextLabel? })`, `millisecondsUntilNextAlignedTick(args)` — по сетке настенных часов; для «каждые N мс» — `startIntervalScheduler` |
| `gracefulShutdown.ts` (3.24.0) | `createGracefulShutdownHandler({ stepList, exit?, log?, exitCode?, forcedExitTimeoutMs?, forcedExitCode? })`, `registerShutdownSignals(handler, signalList?)`, `installProcessErrorGuards({ onError? })` |

## Форматирование цен — `priceFormat.ts` (3.17.0) ⛔️ обязательное

**Ни одна цена не показывается человеку в сыром виде.** Ни в Telegram, ни в тревоге, ни в логе, ни в журнале.

| Экспорт | Что даёт |
|---|---|
| `formatPrice(symbol, price)` | строка на тиковой сетке символа; `—` для `null`/`undefined`/`NaN` |
| `snapPriceToTick(symbol, price, rounding = 'nearest')` | то же числом — для записи в базу/журнал. `rounding: StepRounding` — `'nearest'` (ближайший шаг), `'up'` (не ниже цены), `'down'` (не выше): например, цена лимитной продажи, которая не должна встать ниже плановой, берётся с `'up'`. Математика сетки — в exchange-engine (`priceToPrecision`), здесь только прокидка |
| `configurePriceTickSnapper(snapper)` | ручная установка источника сетки (бэктест, утилиты); `null` — сброс. Снаппер получает `(symbol, price, rounding)` и обязан учитывать направление |

**Подключение автоматическое:** `ExchangeConnector.initialize()` сам ставит снаппер из своих загруженных фильтров символов (futures, затем spot). Приложению делать НИЧЕГО не нужно — достаточно инициализировать коннектор.

Символ без загруженных фильтров печатается не длиннее 8 знаков после точки (`priceToPrecision` в этом случае свалился бы на слепые 8 знаков и испортил бы дешёвые монеты, поэтому значение остаётся точным, но обрезается при выводе).

**Почему:** заявка на бирже всегда лежит на тиковой сетке. Сырое `2.961579786096256` не только нечитаемо — оно не равно тому, что реально стоит на бирже. Повод — тревога rubber по PROMUSDT 11.08.2026 и многократные требования владельца сделать это системно, а не чинить каждый раз заново.

## Форматирование остальных чисел — `numberFormat.ts` (3.23.0) ⛔️ обязательное

Правило `priceFormat.ts` выше касалось только цены. Любое ДРУГОЕ вычисленное число — объём в
USDT, маржа, количество контрактов, процент — после сложения, деления или умножения несёт тот
же хвост плавающей точки и наружу (Telegram, тревоги, логи, журнал) выходит только через эту
дверь:

| Экспорт | Что даёт |
|---|---|
| `formatAmount(symbol, amount)` | строка на шаге количества символа; `—` для `null`/`undefined`/`NaN` |
| `snapAmountToStep(symbol, amount, rounding = 'nearest')` | то же числом — для записи в базу/журнал; направление — как у `snapPriceToTick` |
| `formatUsdAmount(value)` | сумма USDT строкой, не точнее цента |
| `roundUsdAmount(value)` | то же числом |
| `formatPercent(value, maxDigits = 2)` | процент строкой без хвоста плавающей точки |
| `roundPercent(value, maxDigits = 2)` | то же числом |
| `configureAmountStepSnapper(snapper)` | ручная установка источника шага количества (бэктест, утилиты); `null` — сброс. Снаппер получает `(symbol, amount, rounding)` |

**Подключение автоматическое:** `ExchangeConnector.initialize()` ставит снаппер шага количества
тем же путём, что и тиковую сетку цены (`installAmountStepSnapper`, сразу после
`installPriceTickSnapper`). Без коннектора — `configureAmountStepSnapper(...)` вручную.

**Почему:** та же причина, что у цены, но шире — правило `formatPrice` не касалось объёма,
маржи, количества контрактов и процента, и они продолжали утекать наружу сырыми. Повод тот же —
тревога rubber по PROMUSDT 11.08.2026.
