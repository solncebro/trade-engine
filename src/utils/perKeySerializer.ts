// Serializes async work per key into a FIFO promise chain: tasks for the same key run one after
// another, a rejected predecessor does not block the successor. Used to serialize fib lifecycle work
// per symbol in both the live manager and the paper simulator.
class PerKeySerializer {
  private readonly chainByKey: Map<string, Promise<unknown>> = new Map();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chainByKey.get(key) ?? Promise.resolve();
    const next = previous.then(() => task(), () => task());
    const tail = next.then(() => undefined, () => undefined);

    this.chainByKey.set(key, tail);
    // An idle key is dropped, so a long-lived serializer does not keep one entry per key it ever saw.
    // A task queued meanwhile has replaced the tail and keeps the key.
    void tail.then(() => {
      if (this.chainByKey.get(key) === tail) this.chainByKey.delete(key);
    });

    return next;
  }

  /** Keys with a task running or queued. */
  get activeKeyCount(): number {
    return this.chainByKey.size;
  }
}

export { PerKeySerializer };
