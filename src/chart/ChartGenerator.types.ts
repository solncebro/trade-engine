import type { BarSeriesOption, CandlestickSeriesOption, LineSeriesOption } from 'echarts/charts';
import type { GraphicComponentOption, GridComponentOption, LegendComponentOption, TitleComponentOption } from 'echarts/components';
import type { ComposeOption } from 'echarts/core';

import type { Kline, KlineInterval } from '../types/index';

type ChartOption = ComposeOption<CandlestickSeriesOption | LineSeriesOption | BarSeriesOption | GridComponentOption | TitleComponentOption | LegendComponentOption | GraphicComponentOption>;

interface OrderLine {
  price: number;
  label: string;
  color: string;
}

interface GenerateChartArgs {
  klineList: Kline[];
  symbol: string;
  interval: KlineInterval;
  candleCount?: number;
  orderLineList?: OrderLine[];
  drawMaLines?: boolean;
  drawVolumeSubchart?: boolean;
  // Closed-candle events (trigger alerts, creep / MA-approach alerts) set this to drop the still-forming
  // candle so the rightmost candle is the one the event fired on. Default false — interactive / mid-candle
  // charts (create chaser, Symbol info, near-miss, fills, fib preview) keep the live forming candle.
  shouldDropFormingCandle?: boolean;
}

interface VolumeMontageEntry {
  symbol: string;
  klineList: Kline[];
  candleCount?: number;
}

interface GenerateVolumeMontageChartArgs {
  entryList: VolumeMontageEntry[];
}

export type { ChartOption, GenerateChartArgs, GenerateVolumeMontageChartArgs, OrderLine, VolumeMontageEntry };
