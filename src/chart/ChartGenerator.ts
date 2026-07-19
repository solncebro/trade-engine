import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import type { BarSeriesOption, CandlestickSeriesOption, LineSeriesOption } from 'echarts/charts';

import type { ChartOption, GenerateChartArgs, GenerateVolumeMontageChartArgs, OrderLine } from './ChartGenerator.types';

import { logger } from '../core/logger';
import type { Kline, MaLevel } from '../types/index';
import { VOLUME_SMA_PERIOD } from '../types/index';
import { calculateMaSeries, calculateValueMaSeries } from '../utils/indicators';
import { selectClosedKlineList } from '../utils/klineList';

dayjs.extend(utc);

let isEchartsRegistered = false;

async function loadEchartsRuntime() {
  const [core, charts, components, renderers, resvg] = await Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers'),
    import('@resvg/resvg-js'),
  ]);

  if (!isEchartsRegistered) {
    core.use([charts.CandlestickChart, charts.LineChart, charts.BarChart, components.GridComponent, components.TitleComponent, components.LegendComponent, components.GraphicComponent, renderers.SVGRenderer]);
    isEchartsRegistered = true;
  }

  return { init: core.init, Resvg: resvg.Resvg };
}

const CHART_WIDTH = 800;
const CHART_HEIGHT = 400;
const CHART_CANDLE_COUNT = 100;
const CHART_BACKGROUND_COLOR = '#1a1a2e';

// Volume-montage layout: each symbol is one cell (price grid + volume grid + title). With >2 symbols
// the cells are arranged 2 per row (a 2-column grid) so the image stays compact and readable.
// Each symbol cell has a fixed width — the total image width is MONTAGE_CELL_WIDTH * columnCount, so a
// single-symbol/2-symbol (1-column) montage is half as wide as a 3-4-symbol (2-column) one. This keeps
// candle thickness and inter-candle spacing identical across layouts (a fixed total width used to make
// 1-column candles twice as fat as 2-column ones).
const MONTAGE_CELL_WIDTH = 400;
const MONTAGE_ROW_HEIGHT = 333;
const MONTAGE_TITLE_TOP = 6;
const MONTAGE_PRICE_TOP = 28;
const MONTAGE_PRICE_HEIGHT = 207;
const MONTAGE_VOLUME_TOP = 245;
const MONTAGE_VOLUME_HEIGHT = 72;
const MONTAGE_CANDLE_COUNT = 10;
const MONTAGE_CELL_PAD_LEFT = 10;
const MONTAGE_CELL_PAD_RIGHT = 66;
const MONTAGE_CANDLE_BAR_WIDTH = '78%';
// Rasterize at 2x the layout width so the now-narrower montage stays crisp when Telegram upscales it on
// high-DPI screens (the SVG layout — candle thickness, spacing, grid heights — is unchanged; only the
// output PNG resolution doubles).
const MONTAGE_RENDER_SCALE = 2;
const MONTAGE_SEPARATOR_HEIGHT = 4;
const MONTAGE_SEPARATOR_COLOR = '#ffffff';
const CANDLESTICK_ITEM_STYLE = {
  color: '#26a69a',
  color0: '#ef5350',
  borderColor: '#26a69a',
  borderColor0: '#ef5350',
};
const COLOR_VOLUME_UP = '#26a69a';
const COLOR_VOLUME_DOWN = '#ef5350';
const COLOR_VOLUME_SMA = '#f5a623';

const COLOR_BY_MA_LEVEL: Record<MaLevel, string> = {
  25: '#4a90d9',
  50: '#f5a623',
  100: '#8B5C2A',
  200: '#e74c3c',
};

// Chart x-axis labels in UTC (not server-local) — every rendered time across the app is UTC.
function formatChartTimestamp(timestamp: number): string {
  return dayjs.utc(timestamp).format('MM/DD HH:mm');
}

function buildMaSeriesOptionList(fullKlineList: Kline[], displayCount: number): LineSeriesOption[] {
  const maLevelList: MaLevel[] = [25, 50, 100, 200];
  const seriesOptionList: LineSeriesOption[] = [];

  for (const level of maLevelList) {
    const fullSeries = calculateMaSeries(fullKlineList, level);
    const displaySeries = fullSeries.slice(-displayCount);

    seriesOptionList.push({
      name: `MA${level}`,
      type: 'line',
      data: displaySeries as (number | null)[],
      smooth: false,
      lineStyle: { width: 1.5, color: COLOR_BY_MA_LEVEL[level] },
      itemStyle: { color: COLOR_BY_MA_LEVEL[level] },
      symbol: 'none',
      z: 2,
    });
  }

  return seriesOptionList;
}

function buildOrderLineSeriesList(orderLineList: OrderLine[], displayCount: number): LineSeriesOption[] {
  const lastDataIndex = displayCount - 1;

  return orderLineList.map((orderLine, index) => ({
    name: `chaser-line-${index}`,
    type: 'line',
    data: new Array(displayCount).fill(orderLine.price) as number[],
    smooth: false,
    symbol: 'none',
    silent: true,
    z: 3,
    lineStyle: {
      color: orderLine.color,
      type: 'dashed',
      width: 1.5,
    },
    label: {
      show: true,
      formatter: (params: { dataIndex: number }) => params.dataIndex === lastDataIndex ? orderLine.label : '',
      position: 'top',
      color: orderLine.color,
      fontSize: 10,
    },
  }));
}

// Compact volume label: 1234 → "1.2K", 1_500_000 → "1.5M", 2_300_000_000 → "2.3B". Keeps the volume
// y-axis readable instead of spelling out "1,000 / 2,000 / 3,000 ...".
function formatCompactVolume(value: number): string {
  const absValue = Math.abs(value);

  if (absValue >= 1_000_000_000) {
    return `${Number((value / 1_000_000_000).toFixed(1))}B`;
  }

  if (absValue >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }

  if (absValue >= 1_000) {
    return `${Number((value / 1_000).toFixed(1))}K`;
  }

  return `${Math.round(value)}`;
}

// Shared value y-axis for every volume subchart (single chart + montage cells): few ticks (splitNumber 2,
// less cluttered than the auto ~5) and compact K/M/B labels via formatCompactVolume.
function buildVolumeYAxisOption(gridIndex: number): Extract<NonNullable<ChartOption['yAxis']>, readonly unknown[]>[number] {
  return {
    type: 'value',
    scale: true,
    position: 'right',
    gridIndex,
    splitNumber: 2,
    axisLabel: { color: '#888', fontSize: 8, formatter: (value: number): string => formatCompactVolume(value) },
    axisLine: { lineStyle: { color: '#333' } },
    splitLine: { show: false },
  };
}

function buildVolumeSeriesOptionList(fullKlineList: Kline[], displayKlineList: Kline[], displayCount: number, axisIndex = 1, barWidth = '60%'): (BarSeriesOption | LineSeriesOption)[] {
  // Quote volume (USDT) — what the user reads. Both the bars and the SMA-20 line are in quote units so the
  // chart is internally consistent (the breakout detector still fires on base volume — that is separate).
  const quoteVolumeValueList = fullKlineList.map((kline) => kline.quoteAssetVolume);
  const smaDisplaySeries = calculateValueMaSeries(quoteVolumeValueList, VOLUME_SMA_PERIOD).slice(-displayCount);

  const barData = displayKlineList.map((kline) => ({
    value: kline.quoteAssetVolume,
    itemStyle: { color: kline.closePrice >= kline.openPrice ? COLOR_VOLUME_UP : COLOR_VOLUME_DOWN },
  }));

  const barSeries: BarSeriesOption = {
    name: 'Volume',
    type: 'bar',
    data: barData,
    xAxisIndex: axisIndex,
    yAxisIndex: axisIndex,
    barWidth,
    z: 1,
  };

  const smaSeries: LineSeriesOption = {
    name: 'VolSMA20',
    type: 'line',
    data: smaDisplaySeries as (number | null)[],
    xAxisIndex: axisIndex,
    yAxisIndex: axisIndex,
    smooth: false,
    symbol: 'none',
    lineStyle: { width: 1.5, color: COLOR_VOLUME_SMA },
    z: 2,
  };

  return [barSeries, smaSeries];
}

async function generateChart(args: GenerateChartArgs): Promise<Buffer> {
  const { symbol, interval } = args;
  // Default: keep the still-forming candle (isClosed === false) so the chart reflects the live price (the
  // buffer's last candle is updated on every kline tick). Closed-candle events pass shouldDropFormingCandle.
  const klineList = (args.shouldDropFormingCandle ?? false) ? selectClosedKlineList(args.klineList) : args.klineList;
  const drawMaLines = args.drawMaLines ?? true;
  const drawVolumeSubchart = args.drawVolumeSubchart ?? false;
  const displayCount = Math.min(klineList.length, args.candleCount ?? CHART_CANDLE_COUNT);
  const displayKlineList = klineList.slice(-displayCount);

  const categoryDataList = displayKlineList.map((kline) => formatChartTimestamp(kline.openTimestamp));

  const candlestickDataList = displayKlineList.map((kline) => [
    kline.openPrice,
    kline.closePrice,
    kline.lowPrice,
    kline.highPrice,
  ]);

  const firstOpen = displayKlineList[0].openPrice;
  const lastClose = displayKlineList[displayKlineList.length - 1].closePrice;
  const priceChangePercent = ((lastClose - firstOpen) / firstOpen) * 100;
  const isRise = priceChangePercent >= 0;
  const changeLabel = `${isRise ? '+' : ''}${priceChangePercent.toFixed(2)}%`;
  const changeColor = isRise ? '#26a69a' : '#ef5350';

  const maSeriesOptionList = drawMaLines ? buildMaSeriesOptionList(klineList, displayCount) : [];

  const candlestickSeries: CandlestickSeriesOption = {
    name: 'Candlestick',
    type: 'candlestick',
    data: candlestickDataList,
    itemStyle: {
      color: '#26a69a',
      color0: '#ef5350',
      borderColor: '#26a69a',
      borderColor0: '#ef5350',
    },
    z: 1,
  };

  const orderLineSeriesList: LineSeriesOption[] = args.orderLineList && args.orderLineList.length > 0
    ? buildOrderLineSeriesList(args.orderLineList, displayCount)
    : [];

  if (args.orderLineList && args.orderLineList.length > 0) {
    const computedMaByLevel: Record<string, number | null> = {};

    for (const level of [25, 50, 100, 200] as MaLevel[]) {
      const series = calculateMaSeries(klineList, level);
      const lastValue = series[series.length - 1];
      computedMaByLevel[`ma${level}`] = lastValue;
    }

    const orderLinePriceList = args.orderLineList.map((orderLine) => ({ label: orderLine.label, price: orderLine.price }));
    const yDataMin = Math.min(...displayKlineList.map((kline) => kline.lowPrice));
    const yDataMax = Math.max(...displayKlineList.map((kline) => kline.highPrice));

    logger.info({ symbol, interval, klineLength: klineList.length, displayCount, lastClosePrice: klineList[klineList.length - 1]?.closePrice, firstOpenTimestamp: displayKlineList[0]?.openTimestamp, lastOpenTimestamp: displayKlineList[displayKlineList.length - 1]?.openTimestamp, yDataMin, yDataMax, orderLinePriceList, computedMaByLevel }, `[Chart] ${symbol} generateChart orderLineCount=${args.orderLineList.length} klineLen=${klineList.length} displayCount=${displayCount} computedMa50=${computedMaByLevel.ma50} computedMa25=${computedMaByLevel.ma25} yDataRange=${yDataMin}..${yDataMax} [${interval}]`);
  }

  const volumeSeriesOptionList = drawVolumeSubchart
    ? buildVolumeSeriesOptionList(klineList, displayKlineList, displayCount)
    : [];

  const option: ChartOption = {
    backgroundColor: CHART_BACKGROUND_COLOR,
    title: {
      text: `${symbol} [${interval}]`,
      left: 'center',
      top: 8,
      textStyle: { color: '#e0e0e0', fontSize: 14, fontWeight: 'bold' },
    },
    legend: drawMaLines
      ? {
          data: ['MA25', 'MA50', 'MA100', 'MA200'],
          bottom: 4,
          textStyle: { color: '#aaa', fontSize: 10 },
          itemWidth: 14,
          itemHeight: 8,
        }
      : { show: false },
    grid: drawVolumeSubchart
      ? [
          { left: 12, right: 70, top: 34, height: '56%', containLabel: false },
          { left: 12, right: 70, top: '70%', bottom: 26, containLabel: false },
        ]
      : { left: 12, right: 70, top: 40, bottom: 36, containLabel: false },
    xAxis: drawVolumeSubchart
      ? [
          { type: 'category', data: categoryDataList, gridIndex: 0, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#333' } }, splitLine: { show: false } },
          { type: 'category', data: categoryDataList, gridIndex: 1, axisLabel: { color: '#888', fontSize: 9, rotate: 0, interval: Math.floor(displayCount / 5) }, axisLine: { lineStyle: { color: '#333' } }, splitLine: { show: false } },
        ]
      : {
          type: 'category',
          data: categoryDataList,
          axisLabel: { color: '#888', fontSize: 9, rotate: 0, interval: Math.floor(displayCount / 5) },
          axisLine: { lineStyle: { color: '#333' } },
          splitLine: { show: false },
        },
    yAxis: drawVolumeSubchart
      ? [
          { type: 'value', scale: true, position: 'right', gridIndex: 0, axisLabel: { color: '#888', fontSize: 9 }, axisLine: { lineStyle: { color: '#333' } }, splitLine: { lineStyle: { color: '#222' } } },
          buildVolumeYAxisOption(1),
        ]
      : {
          type: 'value',
          scale: true,
          position: 'right',
          axisLabel: { color: '#888', fontSize: 9 },
          axisLine: { lineStyle: { color: '#333' } },
          splitLine: { lineStyle: { color: '#222' } },
        },
    series: [candlestickSeries, ...maSeriesOptionList, ...orderLineSeriesList, ...volumeSeriesOptionList],
    graphic: [{
      type: 'text',
      left: 16,
      top: 10,
      style: {
        text: changeLabel,
        fill: changeColor,
        fontSize: 12,
        fontWeight: 'bold',
      },
    }],
  };

  const { init, Resvg } = await loadEchartsRuntime();

  const chart = init(null, null, {
    renderer: 'svg',
    ssr: true,
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
  });

  chart.setOption(option);

  const svgString = chart.renderToSVGString();
  chart.dispose();

  const resvg = new Resvg(svgString, {
    fitTo: { mode: 'width', value: CHART_WIDTH },
  });

  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return Buffer.from(pngBuffer);
}

async function generateVolumeMontageChart(args: GenerateVolumeMontageChartArgs): Promise<Buffer> {
  const { entryList } = args;

  const columnCount = entryList.length > 2 ? 2 : 1;
  const rowCount = Math.ceil(entryList.length / columnCount);
  const cellWidth = MONTAGE_CELL_WIDTH;
  const montageWidth = MONTAGE_CELL_WIDTH * columnCount;
  const gridWidth = cellWidth - MONTAGE_CELL_PAD_LEFT - MONTAGE_CELL_PAD_RIGHT;
  const totalHeight = rowCount * MONTAGE_ROW_HEIGHT;

  const gridList: NonNullable<ChartOption['grid']> = [];
  const xAxisList: NonNullable<ChartOption['xAxis']> = [];
  const yAxisList: NonNullable<ChartOption['yAxis']> = [];
  const seriesList: NonNullable<ChartOption['series']> = [];
  const graphicList: NonNullable<ChartOption['graphic']> = [];

  entryList.forEach((entry, index) => {
    const row = Math.floor(index / columnCount);
    const col = index % columnCount;
    const base = row * MONTAGE_ROW_HEIGHT;
    const xOffset = col * cellWidth;
    const gridLeft = xOffset + MONTAGE_CELL_PAD_LEFT;
    const priceAxisIndex = index * 2;
    const volumeAxisIndex = index * 2 + 1;

    // Volume-breakout montage keeps the trigger candle rightmost — drop the still-forming candle here only.
    const klineList = selectClosedKlineList(entry.klineList);
    const displayCount = Math.min(klineList.length, entry.candleCount ?? MONTAGE_CANDLE_COUNT);
    const displayKlineList = klineList.slice(-displayCount);
    const categoryDataList = displayKlineList.map((kline) => formatChartTimestamp(kline.openTimestamp));
    const candlestickDataList = displayKlineList.map((kline) => [kline.openPrice, kline.closePrice, kline.lowPrice, kline.highPrice]);

    const firstOpen = displayKlineList[0].openPrice;
    const lastClose = displayKlineList[displayKlineList.length - 1].closePrice;
    const priceChangePercent = ((lastClose - firstOpen) / firstOpen) * 100;
    const isRise = priceChangePercent >= 0;
    const changeLabel = `${isRise ? '+' : ''}${priceChangePercent.toFixed(2)}%`;

    gridList.push(
      { left: gridLeft, width: gridWidth, top: base + MONTAGE_PRICE_TOP, height: MONTAGE_PRICE_HEIGHT, containLabel: false },
      { left: gridLeft, width: gridWidth, top: base + MONTAGE_VOLUME_TOP, height: MONTAGE_VOLUME_HEIGHT, containLabel: false },
    );

    xAxisList.push(
      { type: 'category', data: categoryDataList, gridIndex: priceAxisIndex, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#333' } }, splitLine: { show: false } },
      { type: 'category', data: categoryDataList, gridIndex: volumeAxisIndex, axisLabel: { color: '#888', fontSize: 9, interval: Math.floor(displayCount / 5) }, axisLine: { lineStyle: { color: '#333' } }, splitLine: { show: false } },
    );

    yAxisList.push(
      { type: 'value', scale: true, position: 'right', gridIndex: priceAxisIndex, axisLabel: { color: '#888', fontSize: 9 }, axisLine: { lineStyle: { color: '#333' } }, splitLine: { lineStyle: { color: '#222' } } },
      buildVolumeYAxisOption(volumeAxisIndex),
    );

    seriesList.push(
      { name: `Candlestick-${index}`, type: 'candlestick', data: candlestickDataList, xAxisIndex: priceAxisIndex, yAxisIndex: priceAxisIndex, itemStyle: CANDLESTICK_ITEM_STYLE, barWidth: MONTAGE_CANDLE_BAR_WIDTH, z: 1 },
      ...buildVolumeSeriesOptionList(klineList, displayKlineList, displayCount, volumeAxisIndex, MONTAGE_CANDLE_BAR_WIDTH),
    );

    graphicList.push(
      { type: 'text', left: xOffset + cellWidth / 2, top: base + MONTAGE_TITLE_TOP, style: { text: entry.symbol, fill: '#e0e0e0', fontSize: 13, fontWeight: 'bold', align: 'center' } },
      { type: 'text', left: gridLeft + 4, top: base + MONTAGE_TITLE_TOP + 2, style: { text: changeLabel, fill: isRise ? COLOR_VOLUME_UP : COLOR_VOLUME_DOWN, fontSize: 11, fontWeight: 'bold' } },
    );
  });

  // Thick white dividers so adjacent blocks do not blend: horizontal between rows, vertical between columns.
  for (let row = 1; row < rowCount; row += 1) {
    graphicList.push({
      type: 'rect',
      left: 0,
      top: row * MONTAGE_ROW_HEIGHT - MONTAGE_SEPARATOR_HEIGHT / 2,
      shape: { width: montageWidth, height: MONTAGE_SEPARATOR_HEIGHT },
      style: { fill: MONTAGE_SEPARATOR_COLOR },
      z: 100,
    });
  }

  if (columnCount === 2) {
    graphicList.push({
      type: 'rect',
      left: cellWidth + (MONTAGE_CELL_PAD_LEFT - MONTAGE_SEPARATOR_HEIGHT) / 2,
      top: 0,
      shape: { width: MONTAGE_SEPARATOR_HEIGHT, height: totalHeight },
      style: { fill: MONTAGE_SEPARATOR_COLOR },
      z: 100,
    });
  }

  const option: ChartOption = {
    backgroundColor: CHART_BACKGROUND_COLOR,
    legend: { show: false },
    grid: gridList,
    xAxis: xAxisList,
    yAxis: yAxisList,
    series: seriesList,
    graphic: graphicList,
  };

  const { init, Resvg } = await loadEchartsRuntime();

  const chart = init(null, null, {
    renderer: 'svg',
    ssr: true,
    width: montageWidth,
    height: totalHeight,
  });

  chart.setOption(option);

  const svgString = chart.renderToSVGString();
  chart.dispose();

  const resvg = new Resvg(svgString, {
    fitTo: { mode: 'width', value: montageWidth * MONTAGE_RENDER_SCALE },
  });

  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return Buffer.from(pngBuffer);
}

export { generateChart, generateVolumeMontageChart, selectClosedKlineList };
