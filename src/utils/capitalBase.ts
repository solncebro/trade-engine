import { WalletTypeEnum } from '@solncebro/exchange-engine';

import type { CapitalBaseReading, ReadCapitalBaseArgs, SubAccountCapitalEntry } from './capitalBase.types';
import { describeExchangeRefusal } from './errorFormatter.utils';

import { logger } from '../core/logger';
import { withRetryOn429 } from '../core/withRetryOn429';

const DEFAULT_CAPITAL_ASSET = 'USDT';

/**
 * "Capital base = master + all sub-accounts": the realized (wallet) balance of one asset, USDT by
 * default, summed over the master account and the listed sub-accounts. Wallet balance, not equity —
 * an open position's unrealized result must not move the base. A coin an account does not hold is a
 * real zero (both exchanges leave zero coins out of the answer); an account that could not be read
 * makes the total null, because a sum missing one account silently shrinks every size derived from it.
 * Accounts are read one after another to stay gentle on the exchange's weight limits.
 */
async function readCapitalBase(args: ReadCapitalBaseArgs): Promise<CapitalBaseReading> {
  const asset = args.asset ?? DEFAULT_CAPITAL_ASSET;
  const walletType = args.walletType ?? WalletTypeEnum.UsdtFutures;
  let masterWalletBalance: number | null = null;
  let masterErrorText: string | null = null;

  try {
    const balances = await withRetryOn429({
      fn: () => args.masterClient.fetchBalances(),
      contextLabel: 'fetchBalances master capital base',
    });
    const balance = balances.balanceByAsset.get(asset);

    // Bybit fills walletBalance; Binance futures puts the wallet balance into total.
    masterWalletBalance = balance === undefined ? 0 : (balance.walletBalance ?? balance.total);
  } catch (error: unknown) {
    masterErrorText = describeExchangeRefusal(error);
    logger.warn({ error, asset }, '[CapitalBase] the master account balance could not be read');
  }

  const subAccountEntryList: SubAccountCapitalEntry[] = [];

  for (const subAccountId of args.subAccountIdList) {
    // Only the counted asset: Bybit's unified wallet refuses a balance read without a coin list (live, 26.09.2026).
    const result = await args.subAccountGateway.fetchSubAccountBalanceList({ subAccountId, walletType, assetList: [asset] });

    if (!result.isSuccess) {
      subAccountEntryList.push({ subAccountId, walletBalance: null, errorText: result.errorText });

      continue;
    }

    const balance = result.balanceList.find(item => item.asset === asset);

    subAccountEntryList.push({ subAccountId, walletBalance: balance?.walletBalance ?? 0, errorText: null });
  }

  const walletBalanceList = [masterWalletBalance, ...subAccountEntryList.map(entry => entry.walletBalance)];
  const isComplete = walletBalanceList.every(value => value !== null);
  const totalWalletBalance = isComplete
    ? walletBalanceList.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;

  return { totalWalletBalance, masterWalletBalance, masterErrorText, subAccountEntryList };
}

export { readCapitalBase };
