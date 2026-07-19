/**
 * Splits a list into consecutive chunks of at most `size` elements, preserving order.
 *
 * Used to keep exchange batch requests within the Bybit V5 per-frame cap of 10 orders
 * (linear futures). See `enqueueCreateMultiOrderBatch` / `enqueueCreateTpSplitFan` /
 * `enqueueCancelBatch` in OrderManager.
 */
function chunkList<T>(list: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunkList: size must be a positive integer, got ${size}`);
  }

  const result: T[][] = [];

  for (let start = 0; start < list.length; start += size) {
    result.push(list.slice(start, start + size));
  }

  return result;
}

export { chunkList };
