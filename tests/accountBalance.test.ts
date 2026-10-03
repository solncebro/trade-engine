import type { AccountBalances } from '@solncebro/exchange-engine';

import { readAccountBalance, readFreeMarginUsd, readSpotQuoteBalance } from '../src/utils/accountBalance';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

function buildClient(balances: AccountBalances | Error) {
  return {
    fetchBalances: jest.fn(async (): Promise<AccountBalances> => {
      if (balances instanceof Error) {
        throw balances;
      }

      return balances;
    }),
  };
}

describe('readAccountBalance (futures)', () => {
  it('reads total, free and the margin in use as the exchange reports them', async () => {
    const client = buildClient({ totalWalletBalance: 1000, totalAvailableBalance: 700, totalInitialMargin: 250, balanceByAsset: new Map(), availableBalanceSource: 'exchange' });

    expect(await readAccountBalance(client)).toEqual({ totalUsd: 1000, availableUsd: 700, usedUsd: 250 });
  });

  it('falls back to the difference only without a margin figure, never below zero (Bybit 29.08.2026: "-1$ in use")', async () => {
    const client = buildClient({ totalWalletBalance: 100, totalAvailableBalance: 101, balanceByAsset: new Map(), availableBalanceSource: 'derived' });

    expect(await readAccountBalance(client)).toEqual({ totalUsd: 100, availableUsd: 101, usedUsd: 0 });
  });

  it('an underivable free balance is null, not zero', async () => {
    const client = buildClient({ totalWalletBalance: 100, totalAvailableBalance: 0, balanceByAsset: new Map(), availableBalanceSource: 'unknown' });

    expect(await readAccountBalance(client)).toBeNull();
    expect(await readFreeMarginUsd(client)).toBeNull();
  });

  it('a refused read is null', async () => {
    expect(await readAccountBalance(buildClient(new Error('Unmatched IP')))).toBeNull();
  });

  it('readFreeMarginUsd gives the free figure', async () => {
    const client = buildClient({ totalWalletBalance: 1000, totalAvailableBalance: 640.5, totalInitialMargin: 300, balanceByAsset: new Map(), availableBalanceSource: 'exchange' });

    expect(await readFreeMarginUsd(client)).toBe(640.5);
  });
});

describe('readSpotQuoteBalance', () => {
  const balanceByAsset = new Map([
    ['USDT', { asset: 'USDT', free: 80, locked: 20, total: 100 }],
    ['BTC', { asset: 'BTC', free: 0.5, locked: 0, total: 0.5 }],
  ]);

  it('reads only the quote coin — never the cross-coin sum', async () => {
    const client = buildClient({ totalWalletBalance: 100.5, totalAvailableBalance: 80.5, balanceByAsset });

    expect(await readSpotQuoteBalance({ client })).toEqual({ totalUsd: 100, availableUsd: 80, usedUsd: 20 });
  });

  it('a coin the account does not hold is a real zero; a failed read is null', async () => {
    expect(await readSpotQuoteBalance({ client: buildClient({ totalWalletBalance: 0, totalAvailableBalance: 0, balanceByAsset }), quoteAsset: 'USDC' })).toEqual({ totalUsd: 0, availableUsd: 0, usedUsd: 0 });
    expect(await readSpotQuoteBalance({ client: buildClient(new Error('down')) })).toBeNull();
  });
});
