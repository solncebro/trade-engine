function normalizeNumberInput(text: string, extraStrip?: RegExp): string {
  let cleaned = text.trim().replace(',', '.');

  if (extraStrip) {
    cleaned = cleaned.replace(extraStrip, '');
  }

  return cleaned;
}

export { normalizeNumberInput };
