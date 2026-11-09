# Слой стратегической торговли — мониторы позиций

Часть `strategy-trading.md` (см. индекс там). Базовый `PositionMonitor` и подключаемый `GenericPnlMonitor`: конструкторы, что реализуют сами, protected-хуки, Telegram-меню позиций, константы. Порты `PositionStore` / `MarketDataSource`, модель `MonitoredPosition` и `OrderManager`, через который идут все ордерные операции, — в индексе и в `strategy-trading-order-manager.md`.

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

**Доступ (3.24.0).** Пускать ли обновление в бота, решает `createAccessGuard` + `createAccessControl({ allowedPeerList: [chatId], shouldAllowAllWhenEmpty: false })` из telegram-engine (поле `this.accessGuard`); первая промежуточная функция бота зовёт `accessGuard.isAllowedContext(ctx)`. `accessGuard.middleware` не используется: он сам ловит ошибки обработчиков, а они должны доходить до сторожа падений `createBot`, который шлёт в чат «⚠️ Oops …». Типы `Context` / `Telegraf` — из telegram-engine.

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
