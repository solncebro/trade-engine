// Serializes async work per key into a FIFO promise chain: tasks for the same key run one after
// another, a rejected predecessor does not block the successor. Used to serialize fib lifecycle work
// per symbol in both the live manager and the paper simulator.
class PerKeySerializer {
  private readonly chainByKey: Map<string, Promise<unknown>> = new Map();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chainByKey.get(key) ?? Promise.resolve();
    const next = previous.then(() => task(), () => task());

    this.chainByKey.set(key, next.then(() => undefined, () => undefined));

    return next;
  }
}

export { PerKeySerializer };
