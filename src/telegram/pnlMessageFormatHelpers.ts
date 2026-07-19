import type { KlineInterval, MaLevel } from '../types/index';

const emojiByMaLevel: Record<MaLevel, string> = {
  25: '🔵',
  50: '🟡',
  100: '🟤',
  200: '🔴',
};

function formatMaLevel(level: MaLevel): string {
  return `${emojiByMaLevel[level]} MA${level}`;
}

function formatDirection(direction: 'long' | 'short'): string {
  return direction.toUpperCase();
}

function formatTimeframe(interval: KlineInterval): string {
  return `[${interval}]`;
}

function formatExchangeLabel(exchangeName: string): string {
  return exchangeName.charAt(0).toUpperCase() + exchangeName.slice(1);
}

export { formatMaLevel, formatDirection, formatTimeframe, formatExchangeLabel };
