# Дизайн: модуль определения направления тренда (структурный метод)

Дата: 2026-07-20
Статус: дизайн утверждён пользователем в диалоге (выбран структурный метод — «вариант 3», утверждение целиком).

## 1. Цель и требования

Модуль определяет направление и силу тренда актива по закрытым свечам. Требования подтверждены пользователем (выбраны все четыре применения):

1. **Проверка перед сделкой** — стратегия синхронно спрашивает направление и решает, входить ли (например, не открывать позицию против тренда). Решение принимает стратегия, модуль только отвечает.
2. **События о смене тренда** — модуль сам следит за рынком и оповещает, когда направление сменилось.
3. **Информация для человека** — готовое текстовое представление сводки для Telegram.
4. **Численная сила** — не только «вверх/вниз/боковик», но и оценка силы от 0 до 100.

Дополнительно утверждено:

- **Интервалы**: вердикт по каждому интервалу свечей отдельно + сводная картина по всем подключённым интервалам. Модуль не привязан к конкретному списку интервалов — работает с теми, чьи источники свечей ему переданы (в экосистеме сейчас `'5m' | '30m' | '4h'`, см. `ALL_SUPPORTED_INTERVAL_LIST`, `src/types/strategy.ts:9`).
- **Реакция**: вердикт пересчитывается только по закрытым свечам. «Предварительная» оценка по формирующейся свече не считается.
- **Метод**: структура рынка — локальные вершины и впадины (метод Доу), выбор пользователя.

## 2. Термины

- **Точка структуры (pivot)** — подтверждённая локальная вершина (по `highPrice`) или впадина (по `lowPrice`).
- **Шаг структуры** — сравнение точки с предыдущей точкой того же типа (вершина с вершиной, впадина с впадиной): шаг вверх или шаг вниз.
- **Слом структуры** — закрытие свечи за уровнем последней подтверждённой противоположной точки действующего тренда.
- **ATR (средний истинный размах)** — среднее значение истинного размаха свечи за период; используется как мера волатильности для адаптивного порога.

## 3. Метод расчёта

### 3.1 Поиск вершин и впадин (зигзаг с адаптивным порогом)

Однопроходный алгоритм по списку закрытых свечей:

- Состояние: тип искомой точки (вершина или впадина) и текущий кандидат-экстремум (цена и индекс свечи).
- Экстремумы отслеживаются по `highPrice` (для вершин) и `lowPrice` (для впадин).
- Подтверждение разворота — по `closePrice`: кандидат-вершина подтверждается, когда закрытие свечи ушло вниз от цены кандидата не менее чем на порог разворота; кандидат-впадина — зеркально вверх.
- Порядок обработки каждой свечи: сначала обновление кандидата-экстремума, затем проверка разворота от (возможно обновлённого) кандидата. Одна свеча может и поставить новый экстремум, и подтвердить разворот от него (длинная тень с закрытием у противоположного края).
- Вершины и впадины строго чередуются. Подтверждённая точка никогда не пересматривается задним числом.
- Инициализация: первая свеча — кандидат в обе стороны; тип первой точки определяется первым подтверждённым разворотом.

**Порог разворота** (в процентах от цены кандидата), вычисляется на момент проверки:

```
atrPercent = SMA(TrueRange, atrPeriod) / lastClosePrice × 100
reversalThresholdPercent = max(minReversalPercent, reversalAtrMultiplier × atrPercent)
```

`TrueRange = max(high − low, |high − prevClose|, |low − prevClose|)`. Сглаживание — простое среднее (SMA), без схемы Уайлдера (проще и достаточно).

Адаптивность порога — ключ к работе на разных монетах и интервалах: на спокойной паре ловится мелкая структура, на волатильной не возникает «пилы» из шумовых точек.

### 3.2 Направление

По последним подтверждённым точкам:

- Минимум для вердикта: 2 вершины и 2 впадины. Меньше — статус «данных недостаточно» (`insufficient_data`), отдельный от боковика.
- **Рост (`up`)**: последняя вершина выше предыдущей И последняя впадина выше предыдущей.
- **Падение (`down`)**: последняя вершина ниже предыдущей И последняя впадина ниже предыдущей.
- **Боковик (`flat`)**: всё остальное (в том числе расширяющийся и сжимающийся диапазон).

### 3.3 Слом структуры (досрочное завершение тренда)

- Тренд `up` завершается досрочно, когда свеча **закрылась** ниже последней подтверждённой впадины → направление немедленно становится `flat`, не дожидаясь новых точек.
- Тренд `down` — зеркально: закрытие выше последней подтверждённой вершины → `flat`.
- Переход в противоположный тренд возможен только после подтверждения новых точек по правилу 3.2.
- Учитывается цена закрытия, а не тень свечи — защита от ложных проколов.
- Уровень слома (`structureBreakPrice`) отдаётся наружу в вердикте: для `up` это цена последней подтверждённой впадины, для `down` — последней вершины, для `flat` и `insufficient_data` — `null`.

### 3.4 Сила тренда (0–100)

Три составляющих, каждая 0–100:

1. **Согласованность (`consistencyScore`)** — доля шагов структуры в сторону тренда среди последних `pivotWindowCount − 1` шагов (окно — последние `pivotWindowCount` точек). Все шаги в сторону тренда → 100. При `flat` считается в доминирующую сторону (ту, куда больше шагов; при равенстве — 50).
2. **Крутизна (`steepnessScore`)** — по каждой паре соседних одноимённых точек: ход `ΔP%` (в процентах от цены более ранней точки пары), делённый на `K` — число свечей между ними (разница `klineIndex`); среднее по парам соотносится с `atrPercent`: `clamp(avg(|ΔP%| / K) / atrPercent, 0..1) × 100`. Смысл: какую долю типичного свечного размаха структура проходит за свечу.
3. **Мелкость откатов (`pullbackScore`)** — `clamp(1 − avgRetracement, 0..1) × 100`, где `avgRetracement` — средняя доля отката относительно предыдущего хода по последним парам «ход → откат». Неглубокие откаты → высокий балл.

Итог: `strengthPercent = 0.4 × consistencyScore + 0.3 × steepnessScore + 0.3 × pullbackScore` (веса — внутренние константы, не настройки; выносить в конфигурацию только при реальной необходимости).

При `flat` доминирующая сторона — та, куда больше шагов; `strengthPercent` в этом случае трактуется как «насколько рынок близок к трендовому состоянию». Составляющие отдаются наружу в вердикте — для графиков и разборов.

## 4. Контракты

### 4.1 Чистый расчёт — `TrendCalculator` (статический класс, по образцу `OrderCalculator`)

```typescript
// src/core/trendCalculator.ts
class TrendCalculator {
  static assessTrend(args: AssessTrendArgs): TrendAssessmentResult;
  static computePivotList(args: ComputePivotListArgs): TrendPivot[];  // отдельно — для тестов и графиков
}
```

```typescript
// src/core/trendCalculator.types.ts
type TrendDirection = 'up' | 'down' | 'flat';

interface TrendPivot {
  type: 'high' | 'low';
  price: number;
  klineIndex: number;
  klineOpenTimestamp: number;
}

interface TrendStrengthComponents {
  consistencyScore: number;   // 0..100
  steepnessScore: number;     // 0..100
  pullbackScore: number;      // 0..100
}

interface TrendAssessment {
  direction: TrendDirection;
  strengthPercent: number;            // 0..100
  strengthComponents: TrendStrengthComponents;
  pivotList: TrendPivot[];            // подтверждённые точки (все найденные)
  structureBreakPrice: number | null; // уровень слома действующего тренда
  isStructureBroken: boolean;         // true, если flat получен через слом (3.3)
  lastClosePrice: number;
  lastKlineOpenTimestamp: number;
}

type TrendAssessmentResult =
  | { kind: 'assessed'; assessment: TrendAssessment }
  | { kind: 'insufficient_data'; confirmedPivotCount: number; requiredPivotCount: number };

interface TrendCalculatorConfig {
  atrPeriod?: number;              // default 14
  reversalAtrMultiplier?: number;  // default 2
  minReversalPercent?: number;     // default 0.5
  pivotWindowCount?: number;       // default 6 (окно точек для оценки силы)
}

interface AssessTrendArgs {
  klineList: Kline[];              // только закрытые свечи; хронологический порядок
  config?: TrendCalculatorConfig;
}

interface ComputePivotListArgs {
  klineList: Kline[];
  config?: TrendCalculatorConfig;
}
```

Вход — список **закрытых** свечей в хронологическом порядке; за отбор закрытых отвечает вызывающая сторона (в `TrendMonitor` — через существующий помощник `selectClosedKlineList`, `src/utils/klineList.ts`).

### 4.2 Живой наблюдатель — `TrendMonitor` (класс, по образцу `PositionMonitor`)

```typescript
// src/core/TrendMonitor.ts
class TrendMonitor extends EventEmitter {
  constructor(args: TrendMonitorArgs);
  start(): void;                       // первичный проход + подписки
  stop(): void;                        // снятие всех подписок, очистка кэша
  attachMarketDataManager(interval: KlineInterval, marketDataManager: MarketDataSource): void;
  getTrend(symbol: string, interval: KlineInterval): TrendAssessmentResult | undefined;
  getTrendSummary(symbol: string): TrendSummary;
  on(eventName: 'trendChanged', listener: TrendChangedListener): this;
  off(eventName: 'trendChanged', listener: TrendChangedListener): this;
}
```

```typescript
// src/core/TrendMonitor.types.ts
interface TrendMonitorArgs {
  marketDataManagerByInterval: Map<KlineInterval, MarketDataSource>;
  config?: TrendCalculatorConfig;
}

interface TrendChangedEvent {
  symbol: string;
  interval: KlineInterval;
  previousDirection: TrendDirection;
  currentDirection: TrendDirection;
  result: TrendAssessmentResult;       // всегда kind: 'assessed' (см. правила событий)
}

type TrendChangedListener = (event: TrendChangedEvent) => void;

interface TrendSummary {
  byInterval: Map<KlineInterval, TrendAssessmentResult | undefined>;
  alignedDirection: TrendDirection | null;  // направление, если ВСЕ подключённые интервалы дали assessed-вердикт с одним направлением; иначе null
}
```

**Поведение:**

- `start()` — первичный проход: по каждому источнику `getSymbolList()` → `getKlineList(symbol)` → расчёт и заполнение кэша. События при первичном проходе **не** рассылаются (нет «предыдущего» вердикта — нет смены).
- Подписки: `klineClosed` (пересчёт пары «символ + интервал»), `symbolAdded` (немедленный расчёт нового символа без события), `symbolRemoved` (удаление из кэша). Используются перечисленные события порта `MarketDataSource` (`src/core/marketDataSource.types.ts:26-35`).
- Событие `trendChanged` рассылается только при фактической смене направления между двумя `assessed`-вердиктами (сравнение с кэшем). Переходы с участием `insufficient_data` событий не порождают.
- Кэш: `Map<KlineInterval, Map<string, TrendAssessmentResult>>` — только в памяти; после перезапуска восстанавливается первичным проходом (история свечей уже есть у источника).
- `stop()` снимает все подписки (симметрично `on`/`off`) и очищает кэш — утечек подписок нет.
- `attachMarketDataManager` — позднее подключение интервала (как у `PositionMonitor`): подписка + первичный проход по этому источнику без событий.

### 4.3 Текст для Telegram

```typescript
// src/telegram/trendMessageTemplates.ts
function formatTrendSummaryMessage(args: { symbol: string; summary: TrendSummary }): string;
```

Возвращает готовую строку по всем интервалам сводки: направление стрелкой (⬆️ / ⬇️ / ➡️), сила в процентах, отметка о недостатке данных; плюс строка об общем согласии интервалов, если оно есть. Текст интерфейса — английский, как в остальных шаблонах библиотеки (`src/telegram/pnlMessageTemplates.ts`). Эмодзи `📊` не используется (запрет пользователя). Отправка — на стороне приложения через его бота; модуль сам никуда не пишет.

## 5. Границы ответственности (не-цели)

- Не принимает торговых решений и не блокирует сделки — только отвечает и оповещает.
- Не отправляет сообщения в Telegram сам.
- Не считает вердикт по формирующейся свече.
- Ничего не хранит в базе данных.
- Не обращается к бирже напрямую: единственный источник данных — переданные `MarketDataSource`.

## 6. Файлы

| Файл | Содержание |
|---|---|
| `src/core/trendCalculator.ts` | `TrendCalculator` — чистый расчёт |
| `src/core/trendCalculator.types.ts` | Типы расчёта (раздел 4.1) |
| `src/core/TrendMonitor.ts` | `TrendMonitor` — живой наблюдатель |
| `src/core/TrendMonitor.types.ts` | Типы наблюдателя (раздел 4.2) |
| `src/telegram/trendMessageTemplates.ts` | Форматирование сводки |
| `src/index.ts` | Экспорт классов, функций и типов |
| `tests/trendCalculator.test.ts` | Тесты расчёта |
| `tests/trendMonitor.test.ts` | Тесты наблюдателя |
| `tests/trendMessageTemplates.test.ts` | Тесты форматирования |

Документация по завершении: новый файл `.claude/rules/trend.md`, строки в `CLAUDE.md` (ключевые модули) и в таблице подробной документации, запись в `CHANGELOG.md` в текущую черновую версию (не плодить новую версию — договорённость с пользователем).

## 7. Тест-план

**Расчёт (`trendCalculator.test.ts`):**

- Лесенка вверх → `up`, высокая сила; лесенка вниз → `down`.
- Пила-боковик → `flat`.
- V-разворот → смена направления после подтверждения новых точек.
- Слом: рост + закрытие ниже последней впадины → `flat`, `isStructureBroken: true`; прокол тенью без закрытия за уровнем → тренд сохраняется.
- Меньше 2 вершин + 2 впадин → `insufficient_data` с фактическим и требуемым числом точек.
- Адаптивность порога: одинаковая форма движения при разной волатильности даёт сопоставимую структуру (порог растёт с ATR).
- Чередование точек: подряд два максимума без впадины между ними невозможны.
- Составляющие силы: идеальная лесенка → согласованность 100; глубокие откаты снижают `pullbackScore`.
- Пустой список и одна свеча → `insufficient_data`, без исключений.

**Наблюдатель (`trendMonitor.test.ts`)** — на фиктивном `MarketDataSource` (EventEmitter):

- Первичный проход заполняет кэш, событий нет.
- Закрытие свечи со сменой направления → одно событие `trendChanged` с корректными прошлым и новым направлениями.
- Закрытие без смены → события нет.
- Переход `insufficient_data` → `assessed` → события нет.
- `symbolRemoved` → `getTrend` возвращает `undefined`.
- `stop()` → подписки сняты (список слушателей источника пуст), повторные закрытия свечей ничего не пересчитывают.
- `getTrendSummary`: все интервалы согласны → `alignedDirection` заполнено; разногласие или `insufficient_data` на одном из интервалов → `null`.
- `attachMarketDataManager` — поздний интервал появляется в сводке.

## 8. Открытые параметры

Значения по умолчанию (`atrPeriod: 14`, `reversalAtrMultiplier: 2`, `minReversalPercent: 0.5`, `pivotWindowCount: 6`, веса силы 0.4/0.3/0.3) зафиксированы как стартовые. Калибровка на реальных данных — отдельная задача после внедрения; все параметры, кроме весов, уже вынесены в конфигурацию.
