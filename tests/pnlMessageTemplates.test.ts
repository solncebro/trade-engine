import { formatHalfClosedMessage, formatPositionDetailMessage, formatPositionsListMessage, formatProfitAlertMessage, formatTpSplitConfirmation } from '../src/telegram/pnlMessageTemplates';
import type { PositionDetailMessageArgs } from '../src/telegram/pnlMessageTemplates.types';
import { configureAmountStepSnapper } from '../src/utils/numberFormat';
import { configurePriceTickSnapper } from '../src/utils/priceFormat';

const EPIC_TICK = 0.000001;

const epicSnapper = (symbol: string, price: number): number => (symbol === 'EPICUSDT' ? Number((Math.round(price / EPIC_TICK) * EPIC_TICK).toFixed(10)) : price);

const LONG_TAIL_PRICE_PATTERN = /\d\.\d{7,}/;

const ENTRY_PRICE = 0.1 + 0.2 + 0.136;
const BREAKEVEN_PRICE = ENTRY_PRICE * 1.001;
const LAST_PRICE = ENTRY_PRICE + 0.007208;
const LIQUIDATION_PRICE = ENTRY_PRICE * 0.9;
const SHORT_LIQUIDATION_PRICE = 0.1 + 0.4;

function buildDetailArgs(): PositionDetailMessageArgs {
  return {
    symbol: 'EPICUSDT',
    timeframe: '30m',
    direction: 'long',
    maLevel: 50,
    contracts: 1000,
    entryPrice: ENTRY_PRICE,
    breakevenPrice: BREAKEVEN_PRICE,
    lastPrice: LAST_PRICE,
    liquidationPrice: LIQUIDATION_PRICE,
    liquidationDistancePercent: -10,
    pnlPercent: 1.65,
    pnlUsdt: 7.2,
    volumeUsdt: 1000,
    leverage: 10,
    plannedNotionalUsdt: 1000,
    maValueList: [
      { level: 25, price: LAST_PRICE, offsetFromLastPercent: 0 },
      { level: 50, price: ENTRY_PRICE, offsetFromLastPercent: -1.63 },
    ],
    hasInsurance: false,
    insuranceMaLevel: null,
    isInsuranceMissing: false,
    isHalveMarkActive: false,
    isAugmented: false,
    isImported: false,
    breakevenHalfClosePercent: 0.5,
    isTrailingSlEnabled: true,
    isPnlAlertsEnabled: true,
    isAutoCloseEnabled: true,
  };
}

const epicAmountSnapper = (symbol: string, amount: number): number => (symbol === 'EPICUSDT' ? Math.round(amount) : amount);

afterEach(() => {
  configurePriceTickSnapper(null);
  configureAmountStepSnapper(null);
});

describe('pnlMessageTemplates — prices go through formatPrice', () => {
  it('position detail prints entry, breakeven, last, liquidation and MA prices on the tick grid', () => {
    configurePriceTickSnapper(epicSnapper);

    const message = formatPositionDetailMessage(buildDetailArgs());

    expect(message).toContain('Entry: `0.436` | BE: `0.436436`');
    expect(message).toContain('Last: `0.443208`');
    expect(message).toContain('Liq: `0.3924`');
    expect(message).toContain('MA25: `0.443208`');
    expect(message).toContain('MA50: `0.436`');
    expect(message).not.toMatch(LONG_TAIL_PRICE_PATTERN);
  });

  it('caps an unsnapped price at 8 digits when no tick grid is configured', () => {
    const message = formatPositionDetailMessage(buildDetailArgs());

    expect(message).toContain('Entry: `0.436` | BE: `0.436436`');
    expect(message).not.toMatch(LONG_TAIL_PRICE_PATTERN);
  });

  it('positions list and profit alert print snapped prices', () => {
    configurePriceTickSnapper(epicSnapper);

    const listMessage = formatPositionsListMessage({
      exchangeLabel: 'Bybit',
      trackedList: [{
        symbol: 'EPICUSDT',
        direction: 'long',
        entryPrice: ENTRY_PRICE,
        breakevenPrice: BREAKEVEN_PRICE,
        volumeUsdt: 1000,
        leverage: 10,
        contracts: 1000,
        plannedNotionalUsdt: 1000,
        liquidationPrice: LIQUIDATION_PRICE,
        liquidationDistancePercent: -10,
        pnlPercent: 1.65,
        hasInsurance: false,
        insuranceMaLevel: null,
        isInsuranceMissing: false,
        isHalveMarkActive: false,
        isAugmented: false,
        isImported: false,
        breakevenHalfClosePercent: 0.5,
        isTrailingSlEnabled: true,
        isPnlAlertsEnabled: true,
        isAutoCloseEnabled: true,
      }],
      ephemeralList: [{
        symbol: 'EPICUSDT',
        direction: 'short',
        entryPrice: ENTRY_PRICE,
        contracts: 10,
        leverage: 5,
        markPrice: LAST_PRICE,
        pnlPercent: -1.6,
        liquidationPrice: SHORT_LIQUIDATION_PRICE,
      }],
    });
    const alertMessage = formatProfitAlertMessage({
      symbol: 'EPICUSDT',
      timeframe: '30m',
      direction: 'long',
      pnlPercent: 5,
      entryPrice: ENTRY_PRICE,
      lastPrice: LAST_PRICE,
      maLevel: 50,
      isAugmented: false,
      stopLossLevel: 0.5,
    });

    expect(listMessage).toContain('Entry: `0.436` | BE: `0.436436`');
    expect(listMessage).toContain('Entry: `0.436` · Last: `0.443208`');
    expect(listMessage).toContain('Liq: `0.5`');
    expect(alertMessage).toContain('Entry: `0.436` → Last: `0.443208`');
    expect(listMessage).not.toMatch(LONG_TAIL_PRICE_PATTERN);
    expect(alertMessage).not.toMatch(LONG_TAIL_PRICE_PATTERN);
  });
});

describe('pnlMessageTemplates — computed contracts and USDT sums go through the number formatters', () => {
  it('take-profit plan prints part amounts on the lot step and sizes with cents', () => {
    configurePriceTickSnapper(epicSnapper);
    configureAmountStepSnapper(epicAmountSnapper);

    const message = formatTpSplitConfirmation({
      symbol: 'EPICUSDT',
      direction: 'long',
      maLevel: 50,
      parts: 3,
      totalContracts: 1000,
      entryPrice: ENTRY_PRICE,
      partList: [
        { price: LAST_PRICE, amount: 1000 / 3 },
        { price: LAST_PRICE + 0.01, amount: 1000 / 3 },
        { price: LAST_PRICE + 0.02, amount: 1000 - (1000 / 3) * 2 },
      ],
      tpSizeDisplay: { requestedTpSize: 150, actualTpSize: 145.33333333333334 },
    });

    expect(message).toContain('1. `0.443208` — 333');
    expect(message).toContain('3. `0.463208` — 333');
    expect(message).toContain('TP size: 3 × $145.33 = $436');
    expect(message).not.toMatch(LONG_TAIL_PRICE_PATTERN);
  });

  it('half-closed message prints closed and remaining contracts on the lot step', () => {
    configurePriceTickSnapper(epicSnapper);
    configureAmountStepSnapper(epicAmountSnapper);

    const message = formatHalfClosedMessage({
      symbol: 'EPICUSDT',
      timeframe: '30m',
      direction: 'long',
      maLevel: 50,
      entryPrice: ENTRY_PRICE,
      pnlPercent: 0.1 + 0.2,
      lastPrice: LAST_PRICE,
      closedContracts: 1000 * 0.3,
      remainingContracts: 1000 - 1000 * 0.3,
      isAugmented: false,
    });

    expect(message).toContain('Closed: 300 @ `0.443208`');
    expect(message).toContain('Remaining: 700');
    expect(message).not.toMatch(LONG_TAIL_PRICE_PATTERN);
  });
});
