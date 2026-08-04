import type {
  TrendAssessmentResult,
  TrendDirection,
} from '../src/core/trendCalculator.types';
import type { TrendSummary } from '../src/core/TrendMonitor.types';
import { formatTrendSummaryMessage } from '../src/telegram/trendMessageTemplates';
import type { KlineInterval } from '../src/types/index';

function buildAssessedResult(
  direction: TrendDirection,
  strengthPercent: number
): TrendAssessmentResult {
  return {
    kind: 'assessed',
    assessment: {
      direction,
      strengthPercent,
      strengthComponents: {
        consistencyScore: 0,
        steepnessScore: 0,
        pullbackScore: 0,
      },
      pivotList: [],
      trendStartIndex: null,
      trendEndIndex: null,
      isYoungAfterBreak: false,
      structureBreakPrice: null,
      isStructureBroken: false,
      lastClosePrice: 0,
      lastKlineOpenTimestamp: 0,
    },
  };
}

function buildSummary(
  entryList: [KlineInterval, TrendAssessmentResult | undefined][],
  alignedDirection: TrendDirection | null
): TrendSummary {
  return {
    byInterval: new Map(entryList),
    alignedDirection,
  };
}

describe('formatTrendSummaryMessage', () => {
  test('renders per-interval lines, rounds strength and appends an alignment line', () => {
    const summary = buildSummary(
      [
        ['30m', buildAssessedResult('up', 72.4)],
        ['4h', buildAssessedResult('up', 60)],
      ],
      'up'
    );

    const message = formatTrendSummaryMessage({ symbol: 'BTCUSDT', summary });

    expect(message).toBe(
      [
        'Trend BTCUSDT',
        '⬆️ 30m — up 72%',
        '⬆️ 4h — up 60%',
        'Aligned: ⬆️ up',
      ].join('\n')
    );
  });

  test('omits the alignment line when intervals disagree', () => {
    const summary = buildSummary(
      [
        ['30m', buildAssessedResult('up', 55)],
        ['4h', buildAssessedResult('down', 40)],
      ],
      null
    );

    const message = formatTrendSummaryMessage({ symbol: 'ETHUSDT', summary });

    expect(message).not.toContain('Aligned');
    expect(message).toContain('⬆️ 30m — up 55%');
    expect(message).toContain('⬇️ 4h — down 40%');
  });

  test('renders insufficient data and missing intervals distinctly', () => {
    const summary = buildSummary(
      [
        [
          '30m',
          {
            kind: 'insufficient_data',
            confirmedPivotCount: 1,
            requiredPivotCount: 4,
          },
        ],
        ['5m', undefined],
      ],
      null
    );

    const message = formatTrendSummaryMessage({ symbol: 'SOLUSDT', summary });

    expect(message).toContain('⏳ 30m — not enough data');
    expect(message).toContain('➖ 5m — no data');
  });

  test('never contains the forbidden bar chart emoji', () => {
    const summary = buildSummary(
      [['30m', buildAssessedResult('flat', 20)]],
      null
    );

    const message = formatTrendSummaryMessage({ symbol: 'BTCUSDT', summary });

    expect(message).not.toContain('📊');
    expect(message).toContain('➡️ 30m — flat 20%');
  });
});
