# Слой стратегической торговли (OrderManager · PositionMonitor · GenericPnlMonitor · ChartGenerator)

Этот слой влит в trade-engine из бывшего пакета `@solncebro/ma-trading-core` (склад удалён). Он предоставляет приложениям-стратегиям (`ma-chaser`, `volume-breaker`, …) общую инфраструктуру исполнения ордеров, мониторинга позиций, опциональный PnL-бот и генерацию графиков. Низкоуровневые `ExchangeConnector` / `PositionManager` / watchdog описаны в `architecture.md` и `exchange-connector.md`; здесь — высокоуровневые модули поверх них.

Все модули экспортируются из `@solncebro/trade-engine` (`src/index.ts`).

## Детальная документация

Файл разросся за 30 000 знаков и разделён по теме (09.09.2026) — все три читать как один документ:

| Файл | О чём |
|---|---|
| `strategy-trading.md` (этот файл) | модель `MonitoredPosition`, порты `PositionStore` / `MarketDataSource`, `ChartGenerator`, утилиты слоя |
| [strategy-trading-order-manager.md](strategy-trading-order-manager.md) | `OrderManager`: конструктор, публичный интерфейс, ключевые поведения (гарантированная отмена, per-position FIFO, идемпотентность SL, sub-batch splitting), константы |
| [strategy-trading-monitors.md](strategy-trading-monitors.md) | `PositionMonitor` и `GenericPnlMonitor`: конструкторы, что реализуют сами, protected-хуки, Telegram-меню позиций, константы |

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
| `perKeySerializer.ts` | `PerKeySerializer` — per-key FIFO mutex; ключ удаляется, когда его очередь опустела (`activeKeyCount` — ключи с работой) |
| `intervalScheduler.ts` | `startIntervalScheduler` |
| `loggedExchangeCall.ts` | Обёртки с request/response логированием |
| `nestedField.ts` | `setNestedField`/`buildNestedPartial` |
| `legacyDefaults.ts` | `applyLegacyDefaults` |
| `numberInput.ts` | Парсинг числового ввода |
| `timeout.ts` | `withTimeout<T>` |
| `emoji.ts` | Константы `EMOJI_*` |
