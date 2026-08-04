import type { FormatTrendSummaryMessageArgs } from './trendMessageTemplates.types';

import type {
  TrendAssessmentResult,
  TrendDirection,
} from '../core/trendCalculator.types';
import type { KlineInterval } from '../types/index';

const DIRECTION_ARROW_BY_DIRECTION: Record<TrendDirection, string> = {
  up: '⬆️',
  down: '⬇️',
  flat: '➡️',
};

function formatResultLine(
  interval: KlineInterval,
  result: TrendAssessmentResult | undefined
): string {
  if (result === undefined) {
    return `➖ ${interval} — no data`;
  }

  if (result.kind === 'insufficient_data') {
    return `⏳ ${interval} — not enough data`;
  }

  const { direction, strengthPercent } = result.assessment;
  const arrow = DIRECTION_ARROW_BY_DIRECTION[direction];

  return `${arrow} ${interval} — ${direction} ${Math.round(strengthPercent)}%`;
}

function formatTrendSummaryMessage(
  args: FormatTrendSummaryMessageArgs
): string {
  const { symbol, summary } = args;
  const lineList = [`Trend ${symbol}`];

  for (const [interval, result] of summary.byInterval) {
    lineList.push(formatResultLine(interval, result));
  }

  if (summary.alignedDirection !== null) {
    const arrow = DIRECTION_ARROW_BY_DIRECTION[summary.alignedDirection];
    lineList.push(`Aligned: ${arrow} ${summary.alignedDirection}`);
  }

  return lineList.join('\n');
}

export { formatTrendSummaryMessage };
