export function normalizeSymbol(symbol: string): string {
  const baseSymbol = symbol.split(':')[0];

  return baseSymbol.replace(/[/:.-]/g, '');
}

