import { buildCommandNameFromKey } from '@solncebro/telegram-engine';

/** @deprecated Use `buildCommandNameFromKey` from `@solncebro/telegram-engine`. Kept for compatibility. */
export function getCommandFromKey(key: string): string {
  return buildCommandNameFromKey(key);
}
