import { WalletTypeEnum } from '@solncebro/exchange-engine';
import type { AccountBalances, Balance } from '@solncebro/exchange-engine';

import type { SubAccountBalanceListResult } from '../src/services/subAccountGateway.types';
import { readCapitalBase } from '../src/utils/capitalBase';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

jest.mock('../src/utils/sleep', () => ({ sleep: jest.fn(async () => undefined) }));

const buildBalances = (balanceList: Balance[]): AccountBalances => ({
  totalWalletBalance: 0,
  totalAvailableBalance: 0,
  balanceByAsset: new Map(balanceList.map(balance => [balance.asset, balance])),
});

const buildGateway = (resultBySubAccountId: Record<string, SubAccountBalanceListResult>) => ({
  fetchSubAccountBalanceList: jest.fn(async ({ subAccountId }: { subAccountId: string }) => resultBySubAccountId[subAccountId]),
});

describe('readCapitalBase', () => {
  it('sums the master wallet balance (Binance: total) and every sub-account wallet balance', async () => {
    const masterClient = {
      fetchBalances: jest.fn(async () =>
        buildBalances([{ asset: 'USDT', free: 800, locked: 200, total: 1000 }])
      ),
    };
    const gateway = buildGateway({
      a: {
        isSuccess: true,
        balanceList: [
          { asset: 'USDT', walletBalance: 250.5, transferableBalance: 100 },
          { asset: 'BTC', walletBalance: 1, transferableBalance: 1 },
        ],
      },
      b: { isSuccess: true, balanceList: [] },
    });

    const reading = await readCapitalBase({ masterClient, subAccountGateway: gateway, subAccountIdList: ['a', 'b'] });

    expect(reading).toEqual({
      totalWalletBalance: 1250.5,
      masterWalletBalance: 1000,
      masterErrorText: null,
      subAccountEntryList: [
        { subAccountId: 'a', walletBalance: 250.5, errorText: null },
        { subAccountId: 'b', walletBalance: 0, errorText: null },
      ],
    });
    expect(gateway.fetchSubAccountBalanceList).toHaveBeenCalledWith({ subAccountId: 'a', walletType: WalletTypeEnum.UsdtFutures, assetList: ['USDT'] });
  });

  it('prefers walletBalance over total for the master (Bybit: total = free + locked)', async () => {
    const masterClient = {
      fetchBalances: jest.fn(async () =>
        buildBalances([{ asset: 'USDT', free: 90, locked: 5, total: 95, walletBalance: 100 }])
      ),
    };

    const reading = await readCapitalBase({ masterClient, subAccountGateway: buildGateway({}), subAccountIdList: [] });

    expect(reading.totalWalletBalance).toBe(100);
    expect(reading.masterWalletBalance).toBe(100);
  });

  it('an unreadable sub-account makes the total null but keeps the other figures', async () => {
    const masterClient = { fetchBalances: jest.fn(async () => buildBalances([])) };
    const gateway = buildGateway({
      a: { isSuccess: false, errorText: 'Permission denied', errorCode: 10005, isNotSupported: false },
    });

    const reading = await readCapitalBase({ masterClient, subAccountGateway: gateway, subAccountIdList: ['a'] });

    expect(reading.totalWalletBalance).toBeNull();
    expect(reading.masterWalletBalance).toBe(0);
    expect(reading.subAccountEntryList).toEqual([{ subAccountId: 'a', walletBalance: null, errorText: 'Permission denied' }]);
  });

  it('an unreadable master makes the total null', async () => {
    const masterClient = { fetchBalances: jest.fn(async () => { throw new Error('Invalid API key'); }) };

    const reading = await readCapitalBase({ masterClient, subAccountGateway: buildGateway({}), subAccountIdList: [] });

    expect(reading).toEqual({
      totalWalletBalance: null,
      masterWalletBalance: null,
      masterErrorText: 'Invalid API key',
      subAccountEntryList: [],
    });
  });

  it('honours another asset and wallet type', async () => {
    const masterClient = {
      fetchBalances: jest.fn(async () => buildBalances([{ asset: 'USDC', free: 10, locked: 0, total: 10 }])),
    };
    const gateway = buildGateway({
      a: { isSuccess: true, balanceList: [{ asset: 'USDC', walletBalance: 5, transferableBalance: 5 }] },
    });

    const reading = await readCapitalBase({
      masterClient,
      subAccountGateway: gateway,
      subAccountIdList: ['a'],
      asset: 'USDC',
      walletType: WalletTypeEnum.Spot,
    });

    expect(reading.totalWalletBalance).toBe(15);
    expect(gateway.fetchSubAccountBalanceList).toHaveBeenCalledWith({ subAccountId: 'a', walletType: WalletTypeEnum.Spot, assetList: ['USDC'] });
  });
});
