import { createSequentialQueue } from '../src/utils/sequentialQueue';
import type { SequentialQueueLogger } from '../src/utils/sequentialQueue.types';

const noopLogger: SequentialQueueLogger = { info: () => {}, warn: () => {}, error: () => {} };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(innerResolve => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

describe('createSequentialQueue', () => {
  it('runs tasks strictly in enqueue order, one at a time', async () => {
    const queue = createSequentialQueue({ logger: noopLogger, label: 'test' });
    const runOrderList: string[] = [];
    const gate = deferred();

    queue.enqueue('a', async () => {
      await gate.promise;
      runOrderList.push('a');
    });
    queue.enqueue('b', async () => {
      runOrderList.push('b');
    });

    // "b" must not overtake the blocked "a".
    expect(runOrderList).toEqual([]);
    gate.resolve();
    await queue.drain();
    expect(runOrderList).toEqual(['a', 'b']);
  });

  it('keeps running after a failed task — one broken delivery must not kill the queue', async () => {
    const errorList: string[] = [];
    const logger: SequentialQueueLogger = { ...noopLogger, error: message => { errorList.push(message); } };
    const queue = createSequentialQueue({ logger, label: 'test' });
    const runOrderList: string[] = [];

    queue.enqueue('boom', async () => {
      throw new Error('render exploded');
    });
    queue.enqueue('after', async () => {
      runOrderList.push('after');
    });

    await queue.drain();
    expect(runOrderList).toEqual(['after']);
    expect(errorList.some(message => message.includes('render exploded'))).toBe(true);
  });

  it('awaits the yield hook before every task, so a hot entry blocks the delivery, not the other way round', async () => {
    const hotEntry = deferred();
    let isHotEntryRunning = true;
    const queue = createSequentialQueue({
      logger: noopLogger,
      label: 'test',
      beforeTask: async () => {
        if (isHotEntryRunning) {
          await hotEntry.promise;
        }
      },
    });
    const runOrderList: string[] = [];

    queue.enqueue('render', async () => {
      runOrderList.push('render');
    });

    await Promise.resolve();
    expect(runOrderList).toEqual([]);

    isHotEntryRunning = false;
    hotEntry.resolve();
    await queue.drain();
    expect(runOrderList).toEqual(['render']);
  });

  it('survives a broken yield hook — the task still runs and the queue lives on', async () => {
    const queue = createSequentialQueue({
      logger: noopLogger,
      label: 'test',
      beforeTask: async () => {
        throw new Error('hook down');
      },
    });
    const runOrderList: string[] = [];

    queue.enqueue('task', async () => {
      runOrderList.push('task');
    });

    await queue.drain();
    expect(runOrderList).toEqual(['task']);
  });

  it('counts pending tasks and drains to zero', async () => {
    const queue = createSequentialQueue({ logger: noopLogger, label: 'test' });
    const gate = deferred();

    queue.enqueue('a', () => gate.promise);
    queue.enqueue('b', async () => {});

    expect(queue.size()).toBe(2);
    gate.resolve();
    await queue.drain();
    expect(queue.size()).toBe(0);
  });

  it('logs a slow task with its duration', async () => {
    const infoList: string[] = [];
    const queue = createSequentialQueue({ logger: { ...noopLogger, info: message => { infoList.push(message); } }, label: 'q', slowTaskLogMs: 0 });

    queue.enqueue('render', async () => {});
    await queue.drain();

    expect(infoList[0]).toMatch(/^\[q\] task "render" took \d+ms$/);
  });

  it('works with the library logger by default', async () => {
    const queue = createSequentialQueue({ label: 'default-logger' });
    const runOrderList: string[] = [];

    queue.enqueue('task', async () => {
      runOrderList.push('task');
    });

    await queue.drain();
    expect(runOrderList).toEqual(['task']);
  });
});
