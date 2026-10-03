import { ExchangeError, SubAccountTransferDirectionEnum } from '@solncebro/exchange-engine';
import type { FetchSubAccountBalancesArgs, FetchSubAccountTransferArgs, SubAccountClient } from '@solncebro/exchange-engine';

import type {
  SubAccountBalanceListResult,
  SubAccountFailure,
  SubAccountGatewayArgs,
  SubAccountListResult,
  SubAccountTransferOutcome,
  SubAccountTransferRequest,
  SubAccountTransferStatusResult,
} from './subAccountGateway.types';

import { logger } from '../core/logger';
import { withRetryOn429 } from '../core/withRetryOn429';
import { describeExchangeRefusal } from '../utils/errorFormatter.utils';

const SUB_ACCOUNT_NOT_SUPPORTED_CODE = 'SUB_ACCOUNT_NOT_SUPPORTED';

/**
 * The master account's sub-account operations (`connector.subAccounts`), in trade-engine style:
 * every call answers a result with `isSuccess`, a failure carries the exchange's words in `errorText`
 * and its code in `errorCode`, nothing is thrown.
 *
 * Reads retry on 429/5xx. A transfer is NOT retried here: a lost answer does not say whether the
 * money moved, and a blind second POST is exactly what the caller's `transferId` exists to prevent —
 * the caller asks `fetchTransferStatus` with the same id and decides. In demo mode (and on OKX) the
 * exchange layer refuses without going to the network; that failure has `isNotSupported: true`.
 */
class SubAccountGateway {
  private readonly client: SubAccountClient;
  private readonly label: string;

  constructor(args: SubAccountGatewayArgs) {
    this.client = args.client;
    this.label = args.label;
  }

  async listSubAccounts(): Promise<SubAccountListResult> {
    try {
      const subAccountList = await withRetryOn429({
        fn: () => this.client.fetchSubAccountList(),
        contextLabel: `${this.label} fetchSubAccountList`,
      });

      return { isSuccess: true, subAccountList };
    } catch (error: unknown) {
      return this.buildFailure(error, 'list sub-accounts', {});
    }
  }

  async transferToSubAccount(request: SubAccountTransferRequest): Promise<SubAccountTransferOutcome> {
    return this.transfer(request, SubAccountTransferDirectionEnum.MasterToSub);
  }

  async transferFromSubAccount(request: SubAccountTransferRequest): Promise<SubAccountTransferOutcome> {
    return this.transfer(request, SubAccountTransferDirectionEnum.SubToMaster);
  }

  async fetchTransferStatus(args: FetchSubAccountTransferArgs): Promise<SubAccountTransferStatusResult> {
    try {
      const transfer = await withRetryOn429({
        fn: () => this.client.fetchSubAccountTransfer(args),
        contextLabel: `${this.label} fetchSubAccountTransfer`,
      });

      return { isSuccess: true, transfer };
    } catch (error: unknown) {
      return this.buildFailure(error, 'read transfer status', { ...args });
    }
  }

  async fetchSubAccountBalanceList(args: FetchSubAccountBalancesArgs): Promise<SubAccountBalanceListResult> {
    try {
      const balanceList = await withRetryOn429({
        fn: () => this.client.fetchSubAccountBalances(args),
        contextLabel: `${this.label} fetchSubAccountBalances`,
      });

      return { isSuccess: true, balanceList };
    } catch (error: unknown) {
      return this.buildFailure(error, 'read sub-account balance', { ...args });
    }
  }

  private async transfer(
    request: SubAccountTransferRequest,
    direction: SubAccountTransferDirectionEnum
  ): Promise<SubAccountTransferOutcome> {
    try {
      const result = await this.client.transferSubAccountAsset({ ...request, direction });

      logger.info(
        { label: this.label, direction, ...request, exchangeTransferId: result.exchangeTransferId },
        '[SubAccount] transfer accepted'
      );

      return { isSuccess: true, transferId: result.transferId, exchangeTransferId: result.exchangeTransferId };
    } catch (error: unknown) {
      return this.buildFailure(error, 'transfer', { direction, ...request });
    }
  }

  private buildFailure(error: unknown, operation: string, context: Record<string, unknown>): SubAccountFailure {
    const errorCode = error instanceof ExchangeError ? error.code : null;
    const isNotSupported = errorCode === SUB_ACCOUNT_NOT_SUPPORTED_CODE;

    if (isNotSupported) {
      logger.warn({ label: this.label, ...context }, `[SubAccount] ${operation}: not supported here`);
    } else {
      logger.error({ error, label: this.label, ...context }, `[SubAccount] ${operation} failed`);
    }

    return { isSuccess: false, errorText: describeExchangeRefusal(error), errorCode, isNotSupported };
  }
}

export { SubAccountGateway };
