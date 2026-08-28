/** Promise-wrapped setTimeout — the one pause primitive for the library and its consumers. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { sleep };
