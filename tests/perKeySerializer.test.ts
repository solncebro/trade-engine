import { PerKeySerializer } from '../src/utils/perKeySerializer';

async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe('PerKeySerializer', () => {
  it('forgets a key once its queue is empty, after success and after failure', async () => {
    const serializer = new PerKeySerializer();

    await serializer.run('A', async () => 1);
    await expect(serializer.run('B', async () => { throw new Error('rejected'); })).rejects.toThrow('rejected');
    await settle();

    expect(serializer.activeKeyCount).toBe(0);
  });

  it('keeps the key while a later task is queued and runs the tasks in order', async () => {
    const serializer = new PerKeySerializer();
    const orderList: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = serializer.run('A', async () => { await gate; orderList.push('first'); });
    const second = serializer.run('A', async () => { orderList.push('second'); });

    expect(serializer.activeKeyCount).toBe(1);
    release();
    await first;
    await settle();
    await second;
    await settle();

    expect(orderList).toEqual(['first', 'second']);
    expect(serializer.activeKeyCount).toBe(0);
  });

  it('still serializes a task queued after the key was forgotten', async () => {
    const serializer = new PerKeySerializer();

    await serializer.run('A', async () => undefined);
    await settle();
    const orderList: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = serializer.run('A', async () => { await gate; orderList.push('first'); });
    const second = serializer.run('A', async () => { orderList.push('second'); });
    release();
    await Promise.all([first, second]);

    expect(orderList).toEqual(['first', 'second']);
  });
});
