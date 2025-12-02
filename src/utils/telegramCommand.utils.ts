export function getCommandFromKey(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

