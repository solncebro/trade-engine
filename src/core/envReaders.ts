// Typed readers of process.env, shared by every app. A malformed value THROWS instead of silently
// degrading to a default: running a bot on a number the operator never chose is worse than refusing
// to start. Blank (unset or whitespace-only) means "not set" everywhere.

const DEFAULT_CHAT_ID_LIST_VAR_NAME = 'TELEGRAM_ALLOWED_CHAT_IDS';
const TRUE_TEXT_SET = new Set(['true', '1', 'yes', 'on']);
const FALSE_TEXT_SET = new Set(['false', '0', 'no', 'off']);

function readTrimmed(name: string): string | null {
  const rawValue = process.env[name]?.trim();

  return rawValue === undefined || rawValue === '' ? null : rawValue;
}

/** Positive number from the environment, or the fallback when unset. */
export function readPositiveNumber(name: string, fallback: number): number {
  const rawValue = readTrimmed(name);

  if (rawValue === null) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${rawValue}"`);
  }

  return value;
}

/** Trimmed string, or null when unset/blank — never an empty string the caller has to re-check. */
export function readOptionalString(name: string): string | null {
  return readTrimmed(name);
}

/** One of the allowed values, or the fallback when unset. Anything else throws with the allowed list. */
export function readEnum<T extends string>(name: string, allowedValueList: readonly T[], fallback: T): T {
  const rawValue = readTrimmed(name);

  if (rawValue === null) {
    return fallback;
  }

  const matchedValue = allowedValueList.find(allowedValue => allowedValue === rawValue);

  if (matchedValue === undefined) {
    throw new Error(`Invalid ${name}: "${rawValue}". Must be one of: ${allowedValueList.map(value => `"${value}"`).join(', ')}.`);
  }

  return matchedValue;
}

/** true/false, 1/0, yes/no, on/off (any case), or the fallback when unset. */
export function readBoolean(name: string, fallback: boolean): boolean {
  const rawValue = readTrimmed(name);

  if (rawValue === null) {
    return fallback;
  }

  const normalizedValue = rawValue.toLowerCase();

  if (TRUE_TEXT_SET.has(normalizedValue)) {
    return true;
  }

  if (FALSE_TEXT_SET.has(normalizedValue)) {
    return false;
  }

  throw new Error(`${name} must be a boolean (true/false, 1/0, yes/no, on/off), got "${rawValue}"`);
}

/** Comma-separated chat id list; every notification is broadcast to each one. Empty entries from stray
 *  commas are dropped; a list with no usable id throws. */
export function parseChatIdList(raw: string, varName: string = DEFAULT_CHAT_ID_LIST_VAR_NAME): string[] {
  const chatIdList = raw
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0);

  if (chatIdList.length === 0) {
    throw new Error(`${varName} must contain at least one chat id`);
  }

  return chatIdList;
}
