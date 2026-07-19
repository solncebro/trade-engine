# Слой стратегической торговли (OrderManager · PositionMonitor · GenericPnlMonitor · ChartGenerator)

Этот слой влит в trade-engine из бывшего пакета `@solncebro/ma-trading-core` (склад удалён). Он предоставляет приложениям-стратегиям (`ma-chaser`, `volume-breaker`, …) общую инфраструктуру исполнения ордеров, мониторинга позиций, опциональный PnL-бот и генерацию графиков. Низкоуровневые `ExchangeConnector` / `PositionManager` / watchdog описаны в `architecture.md` и `exchange-connector.md`; здесь — высокоуровневые модули поверх них.

Все модули экспортируются из `@solncebro/trade-engine` (`src/index.ts`).

## OrderManager (`src/core/OrderManager.ts`)

Фоновый исполнитель **всех** ордерных операций над биржей: cancel/replace/place/close, batch. Гарантирует подтверждение отмен (WS-confirm + REST `getOrder` fallback), сериализует операции над одной позицией FIFO, дожимает повторными попытками, на исчерпание шлёт critical Telegram-алерт. Полностью RAM-only — никакого Firebase-persist.

### Конструктор

```typescript
new OrderManager({ exchangeConnector: ExchangeConnector; telegramNotifier: TelegramNotifier })
```

Создаётся приложением, `start()` вызывается до создания `PositionMonitor`-подобных классов, инстанс передаётся им в конструктор.

### Public API

```typescript
class OrderManager {
  start(): void
  shutdown(): Promise<void>

  // Cancel
  enqueueCancel(args: EnqueueCancelArgs): Promise<ImmediateCancelOutcome>
  enqueueCancelBatch(args: EnqueueCancelBatchArgs): Promise<ImmediateBatchOutcome>

  // High-level ordered operations (per-position FIFO via runSerializedByKey)
  enqueueReplaceStopLoss(args: ReplaceStopLossArgs): Promise<ReplaceStopLossResult>
  enqueueClosePositionMarket(args: EnqueueClosePositionMarketArgs): Promise<ClosePositionMarketResult>
  enqueueCreateTpSplitFan(args: CreateTpSplitFanArgs): Promise<CreateTpSplitFanResult>

  // Limit-order primitives (без serialization — caller обеспечивает свой lock)
  enqueueCreateLimitOrder(args: CreateLimitOrderArgs): Promise<CreateLimitOrderResult>
  enqueueMoveLimitOrder(args: MoveLimitOrderArgs): Promise<MoveLimitOrderResult>
  enqueueCreateMultiOrderBatch(args: CreateMultiOrderBatchArgs): Promise<CreateMultiOrderBatchResult>

  handleOrderUpdate(event: OrderUpdateEvent): void
  getDiagnostics(): OrderManagerDiagnostics
}
```

Все типы аргументов/результатов — в `OrderManager.types.ts` (реэкспортируются из entry через `export * from './core/OrderManager.types'`).

### Ключевые поведения

- **Гарантированная отмена.** `enqueueCancel` после отправки ждёт `IMMEDIATE_VERIFY_WAIT_MS` WS-подтверждения, затем REST `getOrder` (`waitForImmediateVerify`). Tick-loop (`runTick`, каждые `TICK_INTERVAL_MS`) дожимает pending entry'ы с cooldown'ом и параллелизмом `PARALLELISM_LIMIT`, до `MAX_ATTEMPTS` попыток; при исчерпании — `exhaustEntry` шлёт Telegram-alert через `telegramNotifier.sendMessage`. `ImmediateCancelOutcome.immediateResult` ∈ `'cancelled' | 'filled' | 'pending' | 'failed_to_send'`.
- **Per-position FIFO.** `runSerializedByKey(key, fn)` (приватный async-mutex). `enqueueReplaceStopLoss` / `enqueueClosePositionMarket` / `enqueueCreateTpSplitFan` / `enqueueCreateMultiOrderBatch` сериализуются по ключу `position:${positionId}`. `enqueueCreateLimitOrder` / `enqueueMoveLimitOrder` НЕ сериализуются (caller держит свой lock).
- **Идемпотентность SL по `triggerPrice + amount`.** `enqueueReplaceStopLoss` под mutex'ом сверяет `lastPlacedStopLossByPositionId.get(positionId)` — при совпадении `triggerPrice + amount` и `oldOrderId !== null` возвращает existing `orderId` без exchange-вызова. Защита от concurrent-дубликатов SL.
- **Sub-batch splitting ≤10.** Bybit V5 batch-фрейм принимает максимум `EXCHANGE_BATCH_MAX_SIZE = 10` ордеров. `enqueueCreateMultiOrderBatch` и `enqueueCreateTpSplitFan` делят список через приватный `transmitBatchInSubBatches` (closest-first порядок — caller задаёт `orderedIndexList`), задержка `BATCH_INTER_SUB_BATCH_DELAY_MS` между под-пачками, `leverage`/`marginMode` только в первой под-пачке. `enqueueCancelBatch` чанкит без задержки (отмена латенси-критична). Multi keep-partial (`isPartial` + `failedPartList` + `placedOrderIdByCanonicalIndex`); TP — all-or-nothing rollback.
- **WS hook.** `handleOrderUpdate(event)` снимает запись с tracker'а на terminal-event (canceled/expired/closed) и вызывает `onConfirmed` — должен вызываться ПЕРВЫМ в `onOrderUpdate`-dispatcher приложения, до consumer'ов state.
- **RAM-only.** `pendingByOrderId`, `inFlightOrderIdSet`, `serializationByKey`, `lastPlacedStopLossByPositionId` — только в RAM. На `shutdown` все pending → exhausted (`reason='shutdown'`) + Telegram-алерт. Параметры (tick/cooldown/parallelism/attempts) — захардкожены, не настраиваются.

### Константы

| Константа | Значение | Назначение |
|---|---|---|
| `TICK_INTERVAL_MS` | 1_000 | Scheduler tick для retry |
| `PER_ENTRY_COOLDOWN_MS` | 2_000 | Мин. пауза между REST-попытками одного ордера |
| `PARALLELISM_LIMIT` | 5 | Одновременных REST-операций |
| `MAX_ATTEMPTS` | 8 | Лимит попыток до `onExhausted` |
| `IMMEDIATE_VERIFY_WAIT_MS` | 1_500 | Ожидание WS перед первым REST `getOrder` |
| `HEARTBEAT_INTERVAL_MS` | 30_000 | Alive-лог |
| `ALERT_THRESHOLD_AGE_MS` | 10_000 | Возраст entry для попадания в aggregated alert |
| `IDLE_HEARTBEAT_LOG_THROTTLE_MS` | 300_000 | Throttle idle-heartbeat (через `LogThrottle`) |
| `EXCHANGE_BATCH_MAX_SIZE` | 10 | Макс. ордеров в batch-фрейме Bybit V5 |
| `BATCH_INTER_SUB_BATCH_DELAY_MS` | 1_000 | Задержка между под-пачками create-путей |

Юнит-тесты: `tests/orderManager.test.ts`.

## Strategy data model (`src/types/strategy.ts`)

Модель позиции и MA-индикаторов, общая для всех стратегий-потребителей. Экспортируется из entry через `export * from './types'`.

```typescript
type MaLevel = 25 | 50 | 100 | 200;
const MA_LEVEL_LIST: MaLevel[] = [25, 50, 100, 200];
const VOLUME_SMA_PERIOD = 20;                                       // период SMA по объёму (Volume-стратегии)
const ALL_SUPPORTED_INTERVAL_LIST = ['30m', '5m', '4h'] as const;   // satisfies readonly KlineInterval[]

interface MaValues { ma25: number; ma50: number; ma100: number; ma200: number }

interface MonitoredPosition {
  id: string; symbol: string; timeframe: KlineInterval; direction: 'long' | 'short';
  maLevel: MaLevel; avgPriceOffsetPercent: number; volumeUsdt: number; leverage: number;
  entryPrice: number; liquidationPrice: number; contracts: number;
  lastAcknowledgedThreshold: number;
  stopLossOrderId: string | null; currentStopLossLevel: number; stopLossLastErrorText: string | null;
  insuranceChaserId: string | null; insuranceFailReason: string | null; isInsuranceUnavailableNotified: boolean;
  isLossAlertAcknowledged: boolean; isUserResponded: boolean; isAutoCloseNotified: boolean;
  lastAlertMessageId: number | null;
  tpOrderIdList: string[] | null; multiEntryOrderIdList: string[] | null;
  primaryOrderCount: number; primarySpreadPercent: number | null; primaryAvgVolumeOffsetPercent: number | null;
  plannedNotionalUsdt: number; lastFillKlineOpenTimestamp: number | null;
  entryKlineHighSnapshot: number | null; entryKlineLowSnapshot: number | null;
  halveEnableKlineHighSnapshot: number | null; halveEnableKlineLowSnapshot: number | null; halveEnableKlineOpenTimestamp: number | null;
  isHalveAtBreakevenEnabled: boolean; hasInsuranceCycleCompleted: boolean; isAugmented: boolean;
  isTrailingSlEnabled: boolean; isPnlAlertsEnabled: boolean; isAutoCloseEnabled: boolean;
  isImported: boolean; createdAt: number;
}

interface MonitoredPositionsDocument { [positionId: string]: MonitoredPosition }
```

`MonitoredPosition` несёт поля для всех потребителей сразу: базовые (entry/contracts/SL), insurance (`insuranceChaserId`/`insuranceFailReason`/halve-cycle — используются только подклассами вроде ma-chaser PnlMonitor), мониторинг-флаги (`isTrailingSlEnabled`/`isPnlAlertsEnabled`/`isAutoCloseEnabled`), импорт (`isImported`), entry-kline/halve-kline снапшоты для touch-extreme guard'ов. Приложение, не использующее insurance, просто оставляет соответствующие поля в default-значениях.

## Порт PositionStore (`src/core/positionStore.types.ts`)

Интерфейс хранилища позиций — реализуется приложением (обычно его `FirebaseService`):

```typescript
interface PositionStore {
  loadMonitoredPositions(): Promise<MonitoredPositionsDocument>;
  saveMonitoredPosition(position: MonitoredPosition): Promise<void>;
  updateMonitoredPosition(positionId: string, partial: Partial<MonitoredPosition>): Promise<void>;
  deleteLegacyPositionFields(positionId: string, fieldNameList: string[]): Promise<void>;
  removeMonitoredPosition(positionId: string): Promise<void>;
}
```

`PositionMonitor` и `GenericPnlMonitor` принимают `positionStore` в конструкторе и пишут/читают позиции исключительно через него — никакого прямого Firebase в core.

## Порт MarketDataSource (`src/core/marketDataSource.types.ts`)

Интерфейс источника свечей — реализуется приложением (standalone-менеджер свечей либо `MarketDataClient` из `@solncebro/market-data-feeder`):

```typescript
interface MarketDataSource {
  getInterval(): KlineInterval;
  getIntervalMs(): number;
  getMaValues(symbol: string): MaValues;
  getKlineList(symbol: string): Kline[];
  getCurrentKline(symbol: string): Kline | undefined;
  getSymbolList(): string[];
  getLastKlineOpenTimestamp(symbol: string): number | undefined;
  getLastUpdateTimestamp(symbol: string): number | undefined;
  getStaleSymbolList(): MarketDataStaleSymbol[];
  isStale?(): boolean;
  shutdown(): Promise<void>;
  on(eventName, listener): this;   // klineClosed | klineUpdated | klineUpdatedTick | symbolAdded | symbolRemoved
  off(eventName, listener): this;
}
```

`PositionMonitor` подписывается на `klineClosed` / `klineUpdatedTick` каждого источника из `marketDataManagerByInterval: Map<KlineInterval, MarketDataSource>` для реактивных проверок и multi-order timeout-checker'а.

## PositionMonitor (`src/core/PositionMonitor.ts`)

Базовый **headless** класс мониторинга позиций (без Telegram-UI и без PnL-логики). Подходит приложениям, которым нужны только жизненный цикл позиции, SL/TP-операции и реконсиляция внешнего закрытия. Подклассы добавляют свою логику через protected-хуки.

### Конструктор

```typescript
new PositionMonitor({
  exchangeConnector: ExchangeConnector;
  orderManager: OrderManager;
  marketDataManagerByInterval: Map<KlineInterval, MarketDataSource>;
  positionMode: PositionModeEnum;
  positionStore: PositionStore;
})  // PositionMonitorArgs
```

### Public API (выборка)

- `getPositionListByDirection(direction)`, `getPositionById(id)`, `setOnPositionRemoved(callback)`.
- `closeAndRemovePosition(positionId): Promise<boolean>`.
- `cancelAllTpOrders(positionId): Promise<{ cancelledCount; failedCount }>`, `cancelPendingMultiEntries(positionId): Promise<{ cancelledCount }>`, `cancelFibTakeProfitOrder(positionId, tpOrderId): Promise<boolean>`.
- Fib/импорт-помощники: `importFibPosition(args): Promise<string | null>` (импорт позиции в мониторинг с opt-out флагами + seeding `multiEntryOrderIdList`), `placeFibBreakevenExit(args): Promise<boolean>`, `placeFibTakeProfit(args): Promise<string | null>` (один reduce-only TP, запись в `tpOrderIdList`), `closeFibPositionAtMarket(positionId): Promise<boolean>`.
- WS: `handleOrderUpdate(event): Promise<void>` (drain `multiEntryOrderIdList` на terminal events), `handlePositionUpdate(event): Promise<void>` (RAM-обновление `entryPrice`/`contracts`).
- `attachMarketDataManager(interval, marketDataManager)` — late-attach источника (Tier 2).

### Что реализует сам

- **Poll-цикл** (`pollPositions`, safety-net) — на каждом тике `readPositionState({ symbol, marketType, direction })` (через `PositionManager`), обновление/реконсиляция. Интервал — `PNL_POLL_INTERVAL_MS = 15_000` (реэкспортируется из entry).
- **Stop-loss** — `verifyAndRestoreStopLoss` (REST-проверка + recreate если пропал), `updateStopLoss` (no-regression, persist `currentStopLossLevel`/`stopLossOrderId`/`stopLossLastErrorText`, минимум `MIN_STOP_LOSS_LEVEL = 0.5`%). Все cancel/place идут через `OrderManager`.
- **Реконсиляция внешнего закрытия** — discriminated union `PositionStateResult` (`present` / `absent confirmed|unconfirmed` / `ambiguous`). Удаление позиции только после `EXTERNAL_CLOSE_CONFIRMATION_TICK_COUNT = 2` подряд `absent/confirmed`; `cleanupExchangeOrdersOnExternalClose` чистит orphan-ордера (SL + TP fan + multi-entry) перед `removePosition`.
- **Drain multi-entry** — `drainMultiEntryListAndPersist`, `cancelMultiEntryOnStopLoss`, `handleMultiOrderTimeoutOnKlineClosed` (split present/absent через `splitMultiEntryByPresence`), WS-drain в `handleOrderUpdate`.
- **Реактивные проверки** — `runReactiveCheckers(position, source)` вызывается на `klineUpdatedTick` / `klineClosed` / `positionUpdate`; в базе — no-op (хук для подклассов).
- **Entry-kline guard** — `computeDecisionPnlPercents` через общий kernel `resolveFavourableDecisionPrice`/`resolveUnfavourableDecisionPrice` (`utils/entryKlineGuard.ts`).
- **Импорт/эфемерные** — `scanExchangePositions` (throttle `POSITIONS_SCAN_THROTTLE_MS = 2_000`), `buildImportedPosition` (дефолты `IMPORTED_POSITION_TIMEFRAME = '30m'`, `IMPORTED_POSITION_MA_LEVEL = 200`).
- **LogThrottle** — высокочастотные WS-логи режутся по `WS_UPDATE_LOG_THROTTLE_MS = 60_000`.

База **не** ссылается на chaser/insurance-creation — это ответственность подклассов (проверено: `grep -c "chaserManager\|createInsuranceChaser"` файла = 0).

### Protected-хуки для подклассов

Все no-op по умолчанию (если не указано иное) — переопределяются подклассом:

| Хук | Сигнатура | Назначение |
|---|---|---|
| `onPositionTeardown` | `(position \| null): Promise<void>` | Cleanup при удалении позиции |
| `onExternalCloseStart` | `(position): Promise<void>` | Сигнал начала внешнего закрытия |
| `onExternalCloseInsuranceCleanup` | `(position): Promise<void>` | Отмена insurance при внешнем закрытии |
| `onExternalMultiEntryCancel` | `(position, cancelType): void` | Уведомление об отмене multi-entry |
| `runReactiveCheckers` | `(position, source): Promise<void>` | Реактивные проверки на kline/WS события |
| `getMultiOrderFillTimeoutKlineCount` | `(interval): number \| null` | Per-TF порог timeout multi-order (default `null` = выкл) |
| `notifyMultiOrderTimeout` | `(args): Promise<void>` | Telegram при срабатывании timeout |
| `onPositionEntryChanged` | `(position, prevEntry, prevContracts, event): Promise<void>` | WS-изменение entry/contracts |
| `onCloseAwaitingTick` | `(positionId): void` | Тик окна подтверждения внешнего закрытия |
| `notifyPositionRemovedExternally` | `(args): Promise<void>` | Telegram при удалении внешне закрытой позиции |
| `onPollActivePosition` | `(position, lastPrice): Promise<void>` | Per-poll обработка живой позиции |

Типы аргументов хуков — `PositionMonitor.types.ts` (`MultiOrderTimeoutNotifyArgs`, `PositionRemovedExternallyNotifyArgs`, `ExternalMultiEntryCancelBufferEntry`, `ImportFibPositionArgs`, `PlaceFibBreakevenExitArgs`, `PlaceFibTakeProfitArgs`, `TpSplitOrderPlacementArgs/Result`, `StopLossStatus`).

**Потребитель базового `PositionMonitor`:** `volume-breaker` (`BreakerPositionMonitor extends PositionMonitor`) — без PnL/insurance, монитор нужен только для импорта позиций, ловли внешнего закрытия и кормления свечами/WS-событиями.

## GenericPnlMonitor (`src/core/GenericPnlMonitor.ts`)

`class GenericPnlMonitor extends PositionMonitor` — **подключаемый opt-in** универсальный PnL-слой со своим Telegram-ботом позиций. Приложение, которое его НЕ инстанцирует, никак не затрагивается. Пороги инжектируются через callback `getPnlConfig()`, а НЕ читаются из какого-либо app-specific объекта настроек. App-специфика подключается через protected-хуки.

### Конструктор

```typescript
new GenericPnlMonitor({
  ...PositionMonitorArgs,        // exchangeConnector, orderManager, marketDataManagerByInterval, positionMode, positionStore
  pnlBotToken: string;
  chatId: string;
  getPnlConfig: () => PnlConfig;  // вызывается каждый раз — пороги берутся «живьём»
})  // GenericPnlMonitorArgs

interface PnlConfig {
  profitThresholdPercent: number;
  profitAutoClosePercent: number;
  lossThresholdPercent: number;
  breakevenHalfClosePercent: number;
  trailingStopLossStepPercent: number;
}
```

### Что реализует сам

- **Profit alerts + alarm-loop** — `checkProfitThreshold`, дискретные пинги на каждом шаге `profitThresholdPercent`; alarm повторяется каждые `ALARM_INTERVAL_MS = 30_000` пока позиция жива.
- **Trailing stop-loss** — непрерывный, внутри `checkProfitThreshold`, шаг `trailingStopLossStepPercent`.
- **Loss threshold** — `checkLossThreshold` (с anti-spam guard'ами); fire-decision по unfavourable extreme; хук `onLossThresholdReached` для app-логики (например, создание insurance).
- **Auto-close** — `checkAutoClose` (`profitAutoClosePercent`, sticky-disable после ручного OK).
- **SOS halve-at-breakeven** — `markPositionAsSos` / `handleCancelSos` / `checkBreakevenHalfClose` / `isSosActive` / `applyHalveEnableSnapshot`. Хуки `onHalveCompleted`, `onCancelSos` для app-логики.
- **Split-TP диалог** — `handleTpSplitStart` / `handleTpSplitTpSize` / `computeTpSplitPlan` / `handleTpSplitConfirm`; работает и для tracked, и для эфемерных позиций (`handleEphemeralTpSplitStart`).
- **Жизненный цикл** — `restoreMonitoredPositions` (load + validate на старте), импорт эфемерных (`handleTrackImported`, `scanExchangePositions`), реконсиляция (унаследована от базы).

### Telegram positions UI

**Отправка централизована в telegram-engine.** Все send/edit-reply-markup/delete сообщений идут через `createSender` из `@solncebro/telegram-engine` (поле `this.sender`, ленивый `getBot: () => this.botInstance?.bot`) — у `GenericPnlMonitor` нет своего отправителя и прямых `bot.telegram.sendMessage`. Алерты (`sendMessage`, profit/loss с inline-клавиатурой) шлются через `sender.sendMessage({ message, peer, useMarkdownV2, returnMessageId, replyMarkup })` с экранированием `escapeMarkdownV2WithFormatting`; снятие кнопок старого алерта — `sender.editMessageReplyMarkup`; удаление пользовательских сообщений — `sender.deleteMessage`. Прямой `bot.telegram` остаётся только у `setMyCommands` (регистрация команд) и у `resolveSurface` (telegram-хэндл отдаётся в `menuReplacer` telegram-engine).

`setupBot()` создаёт бота (через хук `createBotInstance` → `createBot`), регистрирует reply-кнопки `💠 Positions` / `✖️ Close menu` и трёхуровневое inline-меню. callback_data-префиксы:

- **Level 1 (список):** `pnl_position_detail:{id}`, `pnl_eph_detail:{symbol}:{direction}`, `pnl_positions_back`, `pnl_positions_close`.
- **Level 2 (детали позиции):** `pnl_auto_tp:{id}` (→ Level 3), `tp_split:{id}` (Split-TP), `pnl_sos:{id}` / `pnl_cancel_sos:{id}` (SOS halve), `pnl_close:{id}`, `pnl_cancel_tp:{id}` (отмена всех TP), `pnl_cancel_multi_entries:{id}`, `pnl_eph_tp:{symbol}:{direction}` / `pnl_eph_track:{symbol}:{direction}` (эфемерные).
- **Level 3 (Auto TP submenu):** `pnl_toggle_trailing_sl:{id}`, `pnl_toggle_alerts:{id}`, `pnl_toggle_auto_close:{id}`, `pnl_auto_tp_back:{id}`.
- **Split-TP диалог:** `tp_split_confirm`, `tp_split_cancel`, `tp_size:{id}`.
- **Alert acknowledge:** `pnl_ok:{id}` (profit), `pnl_loss_ok:{id}` (loss), `pnl_cancel_ins:{id}` (insurance — регистрируется через хук `registerInsuranceCallbackHandlers`).

Render-шаблоны — `src/telegram/pnlMessageTemplates.ts` + `pnlMessageFormatHelpers.ts` (реэкспортируются из entry).

`GenericPnlMonitor` **не** ссылается на chaser/insurance-creation (проверено: `grep -c "chaserManager\|createInsuranceChaser"` файла = 0) — вся специфика инкапсулирована в хуках ниже.

### Protected-хуки для подклассов

| Хук | Сигнатура | Default |
|---|---|---|
| `createBotInstance` | `(args): BotInstance` | `createBot(args)` |
| `onLossThresholdReached` | `(position): Promise<void>` | no-op |
| `onHalveCompleted` | `(position): Promise<void>` | no-op |
| `onCancelSos` | `(position): Promise<{ cancelledInsuranceMaLevel: MaLevel \| null }>` | `{ cancelledInsuranceMaLevel: null }` |
| `resolveInsuranceViewState` | `(position): InsuranceViewState` | `{ hasInsurance: false, insuranceMaLevel: null, isInsuranceMissing: false }` |
| `getTpSizePresetRowList` | `(): PnlAlertButton[][]` | `[]` |
| `resolveNextMaLevel` | `(maLevel): MaLevel \| null` | `null` |
| `registerInsuranceCallbackHandlers` | `(bot): void` | no-op |

Подкласс также может переопределить унаследованные от `PositionMonitor` хуки (`onPositionTeardown`, `onExternalCloseInsuranceCleanup`, `onPositionEntryChanged`, `getMultiOrderFillTimeoutKlineCount`, `notifyMultiOrderTimeout`, `runReactiveCheckers`).

Типы — `GenericPnlMonitor.types.ts`: `PnlConfig`, `GenericPnlMonitorArgs`, `PnlAlertButton`, `PositionsReplyContext`, `TpSplitStep/State/Context/ParsedMode/PlanPart`, `PositionViewState`, `InsuranceViewState`, `MonitoringFlagFieldName`, `AutoTpToggleOptions`.

### Константы

| Константа | Значение | Назначение |
|---|---|---|
| `ALARM_INTERVAL_MS` | 30_000 | Период повторных profit/loss-алертов |
| `LOADING_TEXT` | `'⏳ Loading...'` | Плейсхолдер загрузки |
| `EXTERNAL_CANCEL_FLUSH_DEBOUNCE_MS` | 1_500 | Дебаунс батчинга external multi-entry cancel |
| `DIAGNOSTIC_LOG_THROTTLE_MS` | 300_000 | Throttle per-position диагностических логов |
| `PNL_MENU_BUTTON_POSITIONS` | `'💠 Positions'` | Reply-кнопка |
| `PNL_MENU_BUTTON_CLOSE` | `'✖️ Close menu'` | Reply-кнопка |

**Потребитель `GenericPnlMonitor`:** `ma-chaser` (`PnlMonitor extends GenericPnlMonitor`) — тонкое insurance-расширение, переопределяет insurance/UI хуки (`onLossThresholdReached` создаёт insurance chaser и т.д.). `volume-breaker` использует базовый `PositionMonitor`, но при желании может подключить `GenericPnlMonitor` в будущем.

## ChartGenerator (`src/chart/ChartGenerator.ts`)

Генерация candlestick-PNG через ECharts SSR (`renderer: 'svg', ssr: true`) → `renderToSVGString()` → `@resvg/resvg-js` → PNG-buffer.

**Ленивая загрузка echarts/resvg (важно).** `echarts/*` и `@resvg/resvg-js` НЕ импортируются на верхнем уровне модуля — они подгружаются **динамически внутри** `generateChart`/`generateVolumeMontageChart` через мемоизированный `loadEchartsRuntime()` (регистрация компонентов `use([...])` выполняется один раз). На верхнем уровне остаются только `import type` (стираются компиляцией). Поэтому `require('@solncebro/trade-engine')` (barrel) **не тянет echarts** при загрузке — приложения-потребители без графиков (`market-data-feeder` и пр.), у которых echarts нет в `node_modules`, импортируют barrel без падения; echarts грузится только в момент фактического рендера. `echarts` + `@resvg/resvg-js` объявлены в `dependencies` пакета (+ optional linux-биндинг). Регрессия Фазы A (barrel жадно грузил ChartGenerator→echarts → краш chart-less потребителей) устранена 2026-06-15.

```typescript
generateChart(args: GenerateChartArgs): Promise<Buffer>
generateVolumeMontageChart(args: GenerateVolumeMontageChartArgs): Promise<Buffer>
selectClosedKlineList(klineList)   // реэкспорт helper из utils
```

- **`generateChart`** — один символ; опционально MA-линии (`drawMaLines`, default `true`), volume-subchart (`drawVolumeSubchart`), order-линии (`orderLineList` — горизонтальные dashed, лейбл у правого края через `buildOrderLineSeriesList`).
- **Формирующаяся свеча** — флаг `shouldDropFormingCandle` (default `false`); при `true` вызывает `selectClosedKlineList` (для событий по закрытой свече). Default оставляет live-свечу.
- **`generateVolumeMontageChart`** — несколько символов в одной картинке (сетка price+volume гридов: >2 → 2 колонки, иначе 1; белые разделители). Всегда дропает формирующуюся свечу.

Константы: `CHART_WIDTH = 800`, `CHART_HEIGHT = 400`, `CHART_CANDLE_COUNT = 100`, `MONTAGE_CELL_WIDTH = 400`, `MONTAGE_ROW_HEIGHT = 333`, `MONTAGE_PRICE_HEIGHT = 207`, `MONTAGE_VOLUME_HEIGHT = 72`, `MONTAGE_CANDLE_COUNT = 10`, `MONTAGE_CANDLE_BAR_WIDTH = '78%'`, `MONTAGE_RENDER_SCALE = 2`, `MONTAGE_SEPARATOR_HEIGHT = 4` (+ цветовые константы). Volume-серии — `quoteAssetVolume` (USDT) + SMA-20 линия.

## Утилиты слоя (`src/utils/`)

Влиты из ma-trading-core, реэкспортируются из entry:

| Файл | Назначение |
|---|---|
| `indicators.ts` | `calculateAverageFromValueList`, `calculatePercentChange`, MA/SMA helpers, `calculateOrderPrice`, `calculateBreakevenPrice`, `getMaValue`, … |
| `entryKlineGuard.ts` | `resolveFavourableDecisionPrice` / `resolveUnfavourableDecisionPrice` / `resolveGuardedExtremePrice` — touch-extreme guard на свече входа/включения halve |
| `tpSplit.ts` | Чистая логика Split TP (`buildPriceList`/`buildAmountList`) |
| `orderSize.ts` / `orderSizeInput.ts` | `computeOrderCountFromSize`/`computeActualOrderSize` + парсер USDT-размера |
| `priceIntersection.ts` | `hasPriceCrossedOrderPrice` (resume trading) |
| `breakevenLadder.ts` | Расчёт ladder безубыточного выхода |
| `klineList.ts` | `selectClosedKlineList` и пр. |
| `chunk.ts` | `chunkList` (sub-batch splitting) |
| `perKeySerializer.ts` | `PerKeySerializer` — per-key FIFO mutex |
| `intervalScheduler.ts` | `startIntervalScheduler` |
| `loggedExchangeCall.ts` | Обёртки с request/response логированием |
| `nestedField.ts` | `setNestedField`/`buildNestedPartial` |
| `legacyDefaults.ts` | `applyLegacyDefaults` |
| `numberInput.ts` | Парсинг числового ввода |
| `timeout.ts` | `withTimeout<T>` |
| `emoji.ts` | Константы `EMOJI_*` |
