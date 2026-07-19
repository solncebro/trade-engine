import { TradifiSymbolGate } from '../src/services/tradifiSymbolGate';

interface FakeConnectorArgs {
  universeSequence: string[][];
}

function makeFakeConnector({ universeSequence }: FakeConnectorArgs) {
  let readCount = 0;
  const refreshFuturesTradeSymbols = jest.fn(async () => {});
  const getFuturesSymbols = jest.fn(async () => {
    const index = Math.min(readCount, universeSequence.length - 1);

    readCount++;

    return universeSequence[index];
  });

  return { getFuturesSymbols, refreshFuturesTradeSymbols };
}

describe('TradifiSymbolGate', () => {
  it('initialize loads the allowed universe and asks for the tradifi-free list', async () => {
    const connector = makeFakeConnector({ universeSequence: [['BTCUSDT', 'ETHUSDT']] });
    const gate = new TradifiSymbolGate({ connector });

    await gate.initialize();

    expect(connector.getFuturesSymbols).toHaveBeenCalledWith({ excludeTradifi: true });
    expect(gate.isAllowed('BTCUSDT')).toBe(true);
    expect(gate.isAllowed('IBMUSDT')).toBe(false);
    expect(gate.getAllowedSymbolList()).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('shouldAllowTradifi: true keeps TradFi in — asks for the full list and admits a TradFi symbol', async () => {
    const connector = makeFakeConnector({ universeSequence: [['BTCUSDT', 'IBMUSDT', 'SOXLUSDT']] });
    const gate = new TradifiSymbolGate({ connector, shouldAllowTradifi: true });

    await gate.initialize();

    expect(connector.getFuturesSymbols).toHaveBeenCalledWith({ excludeTradifi: false });
    expect(gate.isAllowed('IBMUSDT')).toBe(true);
    expect(gate.isAllowed('SOXLUSDT')).toBe(true);
    expect(gate.isAllowed('BTCUSDT')).toBe(true);
  });

  it('initialize throws when the universe comes back empty', async () => {
    const connector = makeFakeConnector({ universeSequence: [[]] });
    const gate = new TradifiSymbolGate({ connector });

    await expect(gate.initialize()).rejects.toThrow(/empty/i);
  });

  it('loadUniverse returns the raw read and keeps the previous cache on an empty read', async () => {
    const connector = makeFakeConnector({ universeSequence: [['BTCUSDT'], []] });
    const gate = new TradifiSymbolGate({ connector });

    await gate.initialize();

    const secondRead = await gate.loadUniverse();

    expect(secondRead).toEqual([]);
    expect(gate.isAllowed('BTCUSDT')).toBe(true);
  });

  it('reloadUniverse refreshes the exchange symbol cache before reading', async () => {
    const connector = makeFakeConnector({ universeSequence: [['BTCUSDT'], ['BTCUSDT', 'NEWUSDT']] });
    const gate = new TradifiSymbolGate({ connector });

    await gate.initialize();

    const reloaded = await gate.reloadUniverse();

    expect(connector.refreshFuturesTradeSymbols).toHaveBeenCalledTimes(1);
    expect(reloaded).toEqual(['BTCUSDT', 'NEWUSDT']);
    expect(gate.isAllowed('NEWUSDT')).toBe(true);
  });

  it('classify allows a newcomer that appears after the refresh', async () => {
    const connector = makeFakeConnector({ universeSequence: [['BTCUSDT'], ['BTCUSDT', 'NEWUSDT']] });
    const gate = new TradifiSymbolGate({ connector });

    await gate.initialize();

    await expect(gate.classify('NEWUSDT')).resolves.toBe(true);
    expect(gate.isBlocked('NEWUSDT')).toBe(false);
  });

  it('classify blocks a symbol that stays outside the universe and remembers the verdict', async () => {
    const connector = makeFakeConnector({ universeSequence: [['BTCUSDT']] });
    const gate = new TradifiSymbolGate({ connector });

    await gate.initialize();

    await expect(gate.classify('SOXLUSDT')).resolves.toBe(false);
    expect(gate.isBlocked('SOXLUSDT')).toBe(true);

    await gate.classify('SOXLUSDT');

    expect(connector.refreshFuturesTradeSymbols).toHaveBeenCalledTimes(1);
  });

  it('concurrent classifications share one refresh round-trip', async () => {
    const connector = makeFakeConnector({ universeSequence: [['BTCUSDT'], ['BTCUSDT', 'AUSDT', 'BUSDT']] });
    const gate = new TradifiSymbolGate({ connector });

    await gate.initialize();

    const [first, second] = await Promise.all([gate.classify('AUSDT'), gate.classify('BUSDT')]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(connector.refreshFuturesTradeSymbols).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh keeps the previous universe and does not poison the gate', async () => {
    const connector = makeFakeConnector({ universeSequence: [['BTCUSDT']] });

    connector.refreshFuturesTradeSymbols.mockRejectedValueOnce(new Error('rest down'));

    const gate = new TradifiSymbolGate({ connector });

    await gate.initialize();

    await expect(gate.classify('NEWUSDT')).resolves.toBe(false);
    expect(gate.isAllowed('BTCUSDT')).toBe(true);
  });

  it('filterSymbolList keeps only allowed symbols', async () => {
    const connector = makeFakeConnector({ universeSequence: [['BTCUSDT', 'ETHUSDT']] });
    const gate = new TradifiSymbolGate({ connector });

    await gate.initialize();

    expect(gate.filterSymbolList(['BTCUSDT', 'IBMUSDT', 'ETHUSDT'])).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
});
