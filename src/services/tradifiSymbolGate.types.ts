interface TradifiSymbolGateConnector {
  getFuturesSymbols(options?: { excludeTradifi?: boolean }): Promise<string[]>;
  refreshFuturesTradeSymbols(): Promise<void>;
}

interface TradifiSymbolGateArgs {
  connector: TradifiSymbolGateConnector;
  /** Opt-in switch to let TradFi symbols (tokenized stocks, ETFs, commodities) into the universe.
   *  Default false: TradFi stays filtered out. Only when a consuming app explicitly passes true is
   *  the TradFi filter lifted and those symbols become allowed. */
  shouldAllowTradifi?: boolean;
}

export type { TradifiSymbolGateArgs, TradifiSymbolGateConnector };
