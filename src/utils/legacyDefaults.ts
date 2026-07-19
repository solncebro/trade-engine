function applyLegacyDefaults<T extends Record<string, unknown>>(record: T, defaults: Partial<T>): void {
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const typedKey = key as keyof T;

    if (record[typedKey] === undefined) {
      record[typedKey] = defaultValue as T[keyof T];
    }
  }
}

export { applyLegacyDefaults };
