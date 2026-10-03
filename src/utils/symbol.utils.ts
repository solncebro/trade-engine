export function normalizeSymbol(symbol: string): string {
  const baseSymbol = symbol.split(':')[0];

  return baseSymbol.replace(/[/:.-]/g, '');
}


// Quote coins recognised at the tail of a glued input ("BTCUSDC"); anything else gets USDT appended.
// USD alone is not here: "…USD" is ambiguous with a base that ends in those letters (SUSD, AUSD).
const RAW_SYMBOL_QUOTE_LIST = ['USDT', 'USDC', 'FDUSD'];
const RAW_SYMBOL_DEFAULT_QUOTE = 'USDT';
// Venue decorations people paste along with the name: TradingView perpetual ".P", OKX "-SWAP", "-PERP".
const RAW_SYMBOL_SUFFIX_PATTERN = /(\.P|-SWAP|-PERP)$/;

/**
 * Turns what a human (or a signal channel) typed into an exchange-style symbol: "$pepe", "#BTC",
 * " btc ", "BTC/USDT", "BTCUSDT.P", "PEPE/USDT:USDT", "1000PEPE" → "PEPEUSDT", "BTCUSDT", …,
 * "1000PEPEUSDT". Uppercases, drops the cashtag/hashtag, the settle suffix after ":" and venue
 * decorations, glues base and quote, and appends USDT when no quote is given. Null for input with
 * no letters or digits at all. The prefix search (1000PEPE vs PEPE) is NOT done here — that needs
 * the exchange's ticker list, see ExchangeConnector.resolveFuturesSymbol.
 * Unlike normalizeSymbol (which only strips separators of an exchange-given name) this is for input.
 */
export function parseRawSymbolInput(raw: string): string | null {
  const withoutSettle = raw.trim().toUpperCase().replace(/^[$#]+/, '').split(':')[0].trim();
  const withoutSuffix = withoutSettle.replace(RAW_SYMBOL_SUFFIX_PATTERN, '');
  const separatedPartList = withoutSuffix
    .split(/[/\-_\s]+/)
    .map(part => part.replace(/[^A-Z0-9]/g, ''))
    .filter(part => part.length > 0);

  if (separatedPartList.length === 0) {
    return null;
  }

  // "BTC/USDT" — the part after the separator IS the quote, whatever it is.
  if (separatedPartList.length > 1) {
    return separatedPartList.join('');
  }

  const glued = separatedPartList[0];
  const hasQuote = RAW_SYMBOL_QUOTE_LIST.some(quote => glued.length > quote.length && glued.endsWith(quote));

  return hasQuote ? glued : `${glued}${RAW_SYMBOL_DEFAULT_QUOTE}`;
}
