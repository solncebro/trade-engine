# Определение тренда (TrendCalculator · TrendMonitor)

Модуль определяет направление и силу тренда актива по **закрытым** свечам методом структуры рынка (локальные вершины и впадины, метод Доу). Ничего не торгует, не отправляет в Telegram и не ходит на биржу — только считает, отвечает и оповещает. Всё экспортируется из `@solncebro/trade-engine`.

Дизайн-документ: `docs/superpowers/specs/2026-07-20-trend-detection-design.md`.

## TrendCalculator (`src/core/trendCalculator.ts`)

Статический класс — чистый расчёт, без состояния.

```typescript
class TrendCalculator {
  static computePivotList(args: ComputePivotListArgs): TrendPivot[];
  static assessTrend(args: AssessTrendArgs): TrendAssessmentResult;
}
```

### Конфигурация (`TrendCalculatorConfig`, всё опционально)

| Поле | Default | Назначение |
|------|---------|-----------|
| `atrPeriod` | 14 | Период среднего истинного размаха (ATR) для адаптивного порога |
| `reversalAtrMultiplier` | 1.618 | Множитель ATR в пороге разворота |
| `minReversalPercent` | 0.5 | Нижняя граница порога разворота (в процентах) |
| `maxReversalPercent` | 20 | Верхняя граница порога разворота — чтобы одна экстремальная свеча не раздула ATR так, что настоящий откат перестаёт считаться разворотом |
| `pivotWindowCount` | 6 | Сколько последних точек берётся в окно оценки силы |

### computePivotList — поиск вершин и впадин

Однопроходный зигзаг:
- Экстремумы отслеживаются по `highPrice` (вершины) и `lowPrice` (впадины), подтверждение разворота — по `closePrice`.
- На каждой свече сначала обновляется кандидат-экстремум, затем проверяется разворот от него: одна свеча может и поставить экстремум, и подтвердить разворот от него (длинная тень).
- Порог разворота адаптивный: `clamp(reversalAtrMultiplier × atrPercent, minReversalPercent, maxReversalPercent)`, где `atrPercent = SMA(истинный размах, atrPeriod) / closePrice × 100`. ATR — простое среднее (не Уайлдер), берётся из `calculateAverageFromValueList` (`utils/indicators.ts`). Пока свечей меньше периода, ATR = 0 и порог опускается на пол `minReversalPercent`. Потолок `maxReversalPercent` защищает от ситуации, когда одна вертикальная свеча с огромным истинным размахом раздувает ATR и «проглатывает» реальный откат после себя.
- Вершины и впадины строго чередуются; подтверждённая точка задним числом не пересматривается.
- `< 2` свечей → пустой список.

`TrendPivot = { type: 'high' | 'low'; price; klineIndex; klineOpenTimestamp }`. Цена точки — экстремум тени свечи, не её закрытие.

### assessTrend — вердикт

Возвращает discriminated union:

```typescript
type TrendAssessmentResult =
  | { kind: 'assessed'; assessment: TrendAssessment }
  | { kind: 'insufficient_data'; confirmedPivotCount: number; requiredPivotCount: number };
```

- **`insufficient_data`** — если подтверждено меньше 2 вершин ИЛИ меньше 2 впадин (`requiredPivotCount = 4`). Это состояние отдельно от `flat`.
- **Направление** по последним двум одноимённым точкам: `up` — последняя вершина выше предыдущей И последняя впадина выше предыдущей; `down` — зеркально; иначе `flat`.
- **Слом структуры** (досрочный переход в `flat`): для `up` — если **хоть одна** свеча после последней подтверждённой впадины закрылась ниже неё (не только последняя свеча — проверяется вся история с момента впадины); для `down` — зеркально относительно последней вершины. Учитывается цена закрытия, а не тень (защита от ложных проколов). При сломе `direction='flat'`, `isStructureBroken=true`.
- **`structureBreakPrice`** привязан к финальному направлению: `up` → последняя впадина (уровень, пробой которого закрытием сломает тренд), `down` → последняя вершина, `flat`/сломанный → `null`.
- **`trendStartIndex` / `trendEndIndex`** — границы текущей структурной ноги в `pivotList`. Нога — самый недавний непрерывный отрезок, где вершины и впадины монотонно идут в одну сторону (higher-high + higher-low для роста, зеркально для падения), содержащий ≥2 вершин и ≥2 впадин; `trendStartIndex` — её основание (дно для роста / вершина для падения), `trendEndIndex` — последняя точка, что ещё держит структуру. Точка, которая ломает ногу (например, более низкая вершина), в отрезок **не** входит. Считается даже когда итоговый `direction='flat'` (нога недавно закончилась, рынок перешёл в боковик) — так нумерация/подсветка начинается от реального начала тренда, а не от края графика; `null`, если чистой ноги нет.
- **`isYoungAfterBreak`** — `true`, если направление `up`/`down`, но в недавних точках была впадина ниже предыдущей (для `up`) / вершина выше предыдущей (для `down`), то есть тренд начался сразу после структурного слома. Направление при этом не меняется, но **сила умножается на 0.5** — молодой тренд после слома не должен читаться как сильный.

`TrendAssessment` содержит: `direction`, `strengthPercent` (0–100), `strengthComponents`, `pivotList`, `trendStartIndex`, `trendEndIndex`, `isYoungAfterBreak`, `structureBreakPrice`, `isStructureBroken`, `lastClosePrice`, `lastKlineOpenTimestamp`.

### Сила тренда (`strengthPercent`, 0–100)

Взвешенная сумма трёх составляющих (`TrendStrengthComponents`), веса — внутренние константы `0.4 / 0.3 / 0.3`, считаются по окну последних `pivotWindowCount` точек:

- **`consistencyScore`** — доля одноимённых шагов (сравнение точки с предыдущей точкой того же типа), идущих в сторону тренда. Нулевые шаги (равные цены) отбрасываются. При `flat` берётся доминирующая сторона; при равенстве ненулевых шагов — 50. **Если направленных шагов нет вовсе (мёртвый боковик с равными вершинами и впадинами) — 0** (осознанное отличие от «равенство → 50»: это «движения нет», а не «сбалансированное движение»).
- **`steepnessScore`** — по каждой паре соседних одноимённых точек берётся ход в процентах от более ранней точки, делённый на число свечей между ними; среднее нормируется на `atrPercent` последней свечи: `clamp(avg / atrPercent, 0..1) × 100`. Если ATR не набран (0) — 0.
- **`pullbackScore`** — мелкость откатов через отношение соседних «ног» структуры: `clamp(1 − avg(min(нога, соседняя) / max(нога, соседняя)), 0..1) × 100`. Мелкие откаты против крупных импульсов → высокий балл (осознанное упрощение формулы «доля отката относительно предыдущего хода» из дизайна; знаконезависимо, симметрично для роста и падения).

## TrendMonitor (`src/core/TrendMonitor.ts`)

Живой наблюдатель `extends EventEmitter` поверх источников свечей (`MarketDataSource`).

```typescript
new TrendMonitor({ marketDataManagerByInterval: Map<KlineInterval, MarketDataSource>; config?: TrendCalculatorConfig });
monitor.start();                                     // первичный проход + подписки, БЕЗ событий
monitor.stop();                                      // снятие всех подписок + очистка кэша
monitor.attachMarketDataManager(interval, source);   // поздний интервал
monitor.getTrend(symbol, interval);                  // TrendAssessmentResult | undefined
monitor.getTrendSummary(symbol);                     // TrendSummary
monitor.on('trendChanged', listener);
monitor.off('trendChanged', listener);
```

- **`start()`** — по каждому источнику `getSymbolList()` → `getKlineList()` → `selectClosedKlineList` (формирующаяся свеча отбрасывается) → `assessTrend`, кэш `Map<KlineInterval, Map<symbol, result>>`. Первичный проход событий не шлёт.
- Подписки навешиваются с **сохранением ссылок** на слушатели per-source, поэтому `stop()` снимает их симметрично через `off()` — утечек подписок нет (в отличие от `PositionMonitor`, где слушатели анонимные). События: `klineClosed` → пересчёт пары и, при фактической смене направления между двумя `assessed`-вердиктами, эмит `trendChanged`; `symbolAdded` → пересчёт без события; `symbolRemoved` → удаление из кэша.
- **Событие `trendChanged`** (`TrendChangedEvent { symbol, interval, previousDirection, currentDirection, result }`) шлётся ТОЛЬКО при реальной смене направления между двумя `assessed`-вердиктами. Переходы с участием `insufficient_data` события не порождают. `result` всегда `assessed`.
- **`getTrendSummary`** (`TrendSummary { byInterval; alignedDirection }`): `byInterval` — по всем подключённым интервалам (`undefined`, если символа нет). `alignedDirection` — одно направление, если у ВСЕХ подключённых интервалов `assessed`-вердикт с одинаковым направлением; иначе `null`.
- **`attachMarketDataManager`**: до `start` — только регистрация (подписка отложена до `start`); после `start` — первичный проход без событий + подписка. При переподключении другого источника на тот же интервал прежний источник корректно отписывается.
- Расчёт в слушателе обёрнут в try/catch с логом — сбой источника не роняет процесс и не эмитит.

## Текст для Telegram (`src/telegram/trendMessageTemplates.ts`)

```typescript
formatTrendSummaryMessage({ symbol, summary: TrendSummary }): string;
```

Готовая строка: заголовок, по строке на интервал (стрелка `⬆️`/`⬇️`/`➡️` + направление + сила в процентах; `⏳` — недостаточно данных; `➖` — символа нет), и строка `Aligned: …` только при согласии всех интервалов. Сила округляется до целого процента. Отправку делает приложение своим ботом.

## Границы (не-цели)

Не принимает торговых решений и не блокирует сделки, не отправляет сообщения сам, не считает вердикт по формирующейся свече, ничего не хранит в БД, единственный источник данных — переданные `MarketDataSource`.

## Файлы

| Файл | Содержание |
|------|-----------|
| `src/core/trendCalculator.ts` / `.types.ts` | Чистый расчёт: `computePivotList`, `assessTrend` |
| `src/core/TrendMonitor.ts` / `.types.ts` | Живой наблюдатель |
| `src/telegram/trendMessageTemplates.ts` / `.types.ts` | Форматирование сводки |
| `tests/trendCalculator.test.ts` | Тесты расчёта |
| `tests/trendMonitor.test.ts` | Тесты наблюдателя |
| `tests/trendMessageTemplates.test.ts` | Тесты формата |
| `tests/trendTestKlines.ts` | Общий тестовый помощник (билдеры свечей) |

Дефолты конфигурации и веса силы — стартовые; калибровка на реальных данных — отдельная задача.
