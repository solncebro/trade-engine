import { normalizeNumberInput } from './numberInput';
import type { ParseOrderSizeInputArgs, ParseOrderSizeInputResult } from './orderSizeInput.types';

function parseOrderSizeInput({ text, minValue }: ParseOrderSizeInputArgs): ParseOrderSizeInputResult {
  const cleaned = normalizeNumberInput(text, /\$/g);

  if (cleaned === '') {
    return { isValid: false, error: `Order size must be a positive number >= ${minValue}` };
  }

  const orderSize = Number(cleaned);

  if (!Number.isFinite(orderSize) || orderSize < minValue || orderSize <= 0) {
    return { isValid: false, error: `Order size must be a positive number >= ${minValue}` };
  }

  return { isValid: true, orderSize };
}

export { parseOrderSizeInput };
