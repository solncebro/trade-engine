# Слой стратегической торговли — OrderManager

Часть `strategy-trading.md` (см. индекс там). Фоновый исполнитель ордерных операций: конструктор, публичный интерфейс, ключевые поведения, константы.

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
