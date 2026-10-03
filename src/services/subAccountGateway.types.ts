import type {
  SubAccount,
  SubAccountBalance,
  SubAccountClient,
  SubAccountTransfer,
  WalletTypeEnum,
} from '@solncebro/exchange-engine';

/** A refused or failed sub-account call. Never thrown — returned. */
interface SubAccountFailure {
  isSuccess: false;
  /** The exchange's (or the exchange layer's) own words. */
  errorText: string;
  /** Exchange code (Bybit 131214 "TransferId exist", Binance -1xxx) or the layer's code
   *  (INVALID_TRANSFER_AMOUNT, INVALID_TRANSFER_ID, INVALID_SUB_ACCOUNT_ID, WALLET_TYPE_NOT_SUPPORTED,
   *  NOT_MASTER_ACCOUNT_KEY, SUB_ACCOUNT_NOT_SUPPORTED); null when the error carried none. */
  errorCode: number | string | null;
  /** True for SUB_ACCOUNT_NOT_SUPPORTED: demo mode or an exchange without sub-accounts (OKX). */
  isNotSupported: boolean;
}

type SubAccountListResult = { isSuccess: true; subAccountList: SubAccount[] } | SubAccountFailure;

/** A transfer between the master account and one sub-account; the direction is the method's. */
interface SubAccountTransferRequest {
  /** Binance — the sub-account e-mail; Bybit — the sub-account UID as a digit string. */
  subAccountId: string;
  asset: string;
  amount: number;
  fromWalletType: WalletTypeEnum;
  toWalletType: WalletTypeEnum;
  /** The caller's idempotency id (a UUID suits both exchanges; Bybit requires one). Keep it: it is the
   *  only way to ask later whether a transfer whose answer was lost actually happened. */
  transferId: string;
}

type SubAccountTransferOutcome =
  | { isSuccess: true; transferId: string; exchangeTransferId: string | null }
  | SubAccountFailure;

type SubAccountTransferStatusResult =
  /** transfer null — the exchange knows no transfer with this id (in its lookup window). */
  | { isSuccess: true; transfer: SubAccountTransfer | null }
  | SubAccountFailure;

type SubAccountBalanceListResult = { isSuccess: true; balanceList: SubAccountBalance[] } | SubAccountFailure;

interface SubAccountGatewayArgs {
  client: SubAccountClient;
  /** Log label, e.g. "Bybit". */
  label: string;
}

export type {
  SubAccountBalanceListResult,
  SubAccountFailure,
  SubAccountGatewayArgs,
  SubAccountListResult,
  SubAccountTransferOutcome,
  SubAccountTransferRequest,
  SubAccountTransferStatusResult,
};
