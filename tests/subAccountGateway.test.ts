import {
  ExchangeError,
  ExchangeNameEnum,
  PositionModeEnum,
  SubAccountStatusEnum,
  SubAccountTransferDirectionEnum,
  SubAccountTransferStatusEnum,
  WalletTypeEnum,
} from '@solncebro/exchange-engine';
import type { SubAccountClient } from '@solncebro/exchange-engine';

import { ExchangeConnector } from '../src/services/exchangeConnector';
import { SubAccountGateway } from '../src/services/subAccountGateway';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

jest.mock('../src/utils/sleep', () => ({ sleep: jest.fn(async () => undefined) }));

type FakeSubAccountClient = { [key in keyof SubAccountClient]: jest.Mock };

const createFakeClient = (): FakeSubAccountClient => ({
  fetchSubAccountList: jest.fn(),
  transferSubAccountAsset: jest.fn(),
  fetchSubAccountTransfer: jest.fn(),
  fetchSubAccountBalances: jest.fn(),
});

const TRANSFER_REQUEST = {
  subAccountId: '1234567',
  asset: 'USDT',
  amount: 150,
  fromWalletType: WalletTypeEnum.UsdtFutures,
  toWalletType: WalletTypeEnum.UsdtFutures,
  transferId: '8c6c6d3e-5b1a-4f1e-9c43-2a1d8e0f7b21',
};

describe('SubAccountGateway', () => {
  let client: FakeSubAccountClient;
  let gateway: SubAccountGateway;

  beforeEach(() => {
    client = createFakeClient();
    gateway = new SubAccountGateway({ client: client as unknown as SubAccountClient, label: 'Bybit' });
  });

  it('lists sub-accounts', async () => {
    const subAccountList = [
      { subAccountId: '1234567', name: 'copy-1', note: null, status: SubAccountStatusEnum.Active, createdAt: null },
    ];
    client.fetchSubAccountList.mockResolvedValue(subAccountList);

    await expect(gateway.listSubAccounts()).resolves.toEqual({ isSuccess: true, subAccountList });
  });

  it('transferToSubAccount sends master→sub with the caller id', async () => {
    client.transferSubAccountAsset.mockResolvedValue({ transferId: TRANSFER_REQUEST.transferId, exchangeTransferId: null });

    const outcome = await gateway.transferToSubAccount(TRANSFER_REQUEST);

    expect(client.transferSubAccountAsset).toHaveBeenCalledWith({
      ...TRANSFER_REQUEST,
      direction: SubAccountTransferDirectionEnum.MasterToSub,
    });
    expect(outcome).toEqual({ isSuccess: true, transferId: TRANSFER_REQUEST.transferId, exchangeTransferId: null });
  });

  it('transferFromSubAccount sends sub→master', async () => {
    client.transferSubAccountAsset.mockResolvedValue({ transferId: TRANSFER_REQUEST.transferId, exchangeTransferId: '777' });

    const outcome = await gateway.transferFromSubAccount(TRANSFER_REQUEST);

    expect(client.transferSubAccountAsset.mock.calls[0][0].direction).toBe(SubAccountTransferDirectionEnum.SubToMaster);
    expect(outcome).toEqual({ isSuccess: true, transferId: TRANSFER_REQUEST.transferId, exchangeTransferId: '777' });
  });

  it('a refused transfer is a result with the exchange words and code, never a throw', async () => {
    client.transferSubAccountAsset.mockRejectedValue(new ExchangeError('TransferId exist', 131214, 'bybit'));

    const outcome = await gateway.transferToSubAccount(TRANSFER_REQUEST);

    expect(outcome).toEqual({ isSuccess: false, errorText: 'TransferId exist', errorCode: 131214, isNotSupported: false });
  });

  it('a transfer is never retried, even on a 5xx (the money may have moved)', async () => {
    const serverError = Object.assign(new Error('Bad gateway'), { response: { status: 502 } });
    client.transferSubAccountAsset.mockRejectedValue(serverError);

    const outcome = await gateway.transferToSubAccount(TRANSFER_REQUEST);

    expect(client.transferSubAccountAsset).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ isSuccess: false, errorText: 'Bad gateway', errorCode: null, isNotSupported: false });
  });

  it('reads are retried on 429', async () => {
    const rateLimited = Object.assign(new Error('Too many requests'), { response: { status: 429 } });
    client.fetchSubAccountBalances.mockRejectedValueOnce(rateLimited).mockResolvedValue([]);

    const result = await gateway.fetchSubAccountBalanceList({ subAccountId: 'a', walletType: WalletTypeEnum.Spot });

    expect(client.fetchSubAccountBalances).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ isSuccess: true, balanceList: [] });
  });

  it('fetchTransferStatus passes the lookup through and returns null for an unknown id', async () => {
    const args = {
      subAccountId: '1234567',
      direction: SubAccountTransferDirectionEnum.MasterToSub,
      transferId: TRANSFER_REQUEST.transferId,
    };
    client.fetchSubAccountTransfer.mockResolvedValueOnce(null);

    await expect(gateway.fetchTransferStatus(args)).resolves.toEqual({ isSuccess: true, transfer: null });
    expect(client.fetchSubAccountTransfer).toHaveBeenCalledWith(args);

    const transfer = {
      transferId: args.transferId,
      exchangeTransferId: null,
      asset: 'USDT',
      amount: 150,
      fromAccountId: '1',
      toAccountId: '1234567',
      fromWalletType: WalletTypeEnum.UsdtFutures,
      toWalletType: WalletTypeEnum.UsdtFutures,
      rawFromWalletType: 'UNIFIED',
      rawToWalletType: 'UNIFIED',
      status: SubAccountTransferStatusEnum.Success,
      rawStatus: 'SUCCESS',
      timestamp: 1,
    };
    client.fetchSubAccountTransfer.mockResolvedValueOnce(transfer);

    await expect(gateway.fetchTransferStatus(args)).resolves.toEqual({ isSuccess: true, transfer });
  });

  it('marks the not-supported refusal (demo mode / OKX)', async () => {
    client.fetchSubAccountList.mockRejectedValue(
      new ExchangeError('Sub-account operations are not supported: demo', 'SUB_ACCOUNT_NOT_SUPPORTED', 'bybit')
    );

    const result = await gateway.listSubAccounts();

    expect(result).toEqual(expect.objectContaining({ isSuccess: false, errorCode: 'SUB_ACCOUNT_NOT_SUPPORTED', isNotSupported: true }));
  });
});

describe('ExchangeConnector.subAccounts', () => {
  it('in demo mode refuses with isNotSupported without going to the network (real exchange layer)', async () => {
    const connector = new ExchangeConnector(
      ExchangeNameEnum.Bybit,
      { apiKey: 'k', secret: 's', isDemoMode: true },
      undefined,
      PositionModeEnum.OneWay,
      { isEnabled: false }
    );

    const result = await connector.subAccounts.transferToSubAccount(TRANSFER_REQUEST);

    expect(result).toEqual(expect.objectContaining({ isSuccess: false, errorCode: 'SUB_ACCOUNT_NOT_SUPPORTED', isNotSupported: true }));
    expect(connector.subAccounts).toBe(connector.subAccounts);
  });
});
