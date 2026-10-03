import {
  createGracefulShutdownHandler,
  installProcessErrorGuards,
  registerShutdownSignals,
} from '../src/utils/gracefulShutdown';

const silentLog = (): void => {};

describe('createGracefulShutdownHandler', () => {
  it('runs the steps in order, then exits with code 0', async () => {
    const callOrderList: string[] = [];
    const exit = jest.fn((code: number) => {
      callOrderList.push(`exit:${code}`);
    });
    const handle = createGracefulShutdownHandler({
      stepList: [
        { label: 'journal', run: async () => { callOrderList.push('journal'); } },
        { label: 'feed', run: () => { callOrderList.push('feed'); } },
      ],
      exit,
      log: silentLog,
    });

    await handle('SIGTERM');

    expect(callOrderList).toEqual(['journal', 'feed', 'exit:0']);
  });

  // kliner: a stop that throws must not keep the process alive.
  it('still runs the next steps and exits when a step throws', async () => {
    const exit = jest.fn();
    const laterStep = jest.fn();
    const logList: string[] = [];
    const handle = createGracefulShutdownHandler({
      stepList: [
        { label: 'broken', run: async () => { throw new Error('stop failed'); } },
        { label: 'later', run: laterStep },
      ],
      exit,
      log: message => logList.push(message),
    });

    await handle('SIGINT');

    expect(laterStep).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logList.some(message => message.includes('broken failed: stop failed'))).toBe(true);
  });

  // rubber: a hung write must not hold the shutdown hostage.
  it('moves past a step that exceeds its cap', async () => {
    const exit = jest.fn();
    const laterStep = jest.fn();
    const handle = createGracefulShutdownHandler({
      stepList: [
        { label: 'hung', run: () => new Promise<void>(() => {}), timeoutMs: 20 },
        { label: 'later', run: laterStep },
      ],
      exit,
      log: silentLog,
    });

    await handle('SIGTERM');

    expect(laterStep).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('runs the teardown once when a second signal arrives mid-shutdown', async () => {
    const exit = jest.fn();
    const step = jest.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    const handle = createGracefulShutdownHandler({ stepList: [{ label: 'step', run: step }], exit, log: silentLog });

    await Promise.all([handle('SIGINT'), handle('SIGTERM')]);

    expect(step).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('forces the exit when the whole teardown exceeds its ceiling, and exits only once', async () => {
    const exit = jest.fn();
    let releaseStep: () => void = () => {};
    const handle = createGracefulShutdownHandler({
      stepList: [{ label: 'slow', run: () => new Promise<void>(resolve => { releaseStep = resolve; }) }],
      exit,
      log: silentLog,
      forcedExitTimeoutMs: 20,
    });

    const shutdownPromise = handle('SIGTERM');

    await new Promise(resolve => setTimeout(resolve, 40));
    expect(exit).toHaveBeenCalledWith(1);

    releaseStep();
    await shutdownPromise;
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('registerShutdownSignals', () => {
  it('routes each signal to the handler and unregisters cleanly', () => {
    const handler = jest.fn(async () => {});
    const listenerCountBefore = process.listenerCount('SIGUSR2');
    const unregister = registerShutdownSignals(handler, ['SIGUSR2']);

    expect(process.listenerCount('SIGUSR2')).toBe(listenerCountBefore + 1);
    process.emit('SIGUSR2', 'SIGUSR2');
    expect(handler).toHaveBeenCalledWith('SIGUSR2');
    // `once`: the listener removed itself after firing.
    expect(process.listenerCount('SIGUSR2')).toBe(listenerCountBefore);

    unregister();
  });
});

describe('installProcessErrorGuards', () => {
  it('reports a stray rejection and exception instead of crashing, and uninstalls', () => {
    const onError = jest.fn();
    const uninstall = installProcessErrorGuards({ onError });
    const reason = new Error('lost promise');

    process.emit('unhandledRejection', reason, Promise.resolve());
    process.emit('uncaughtException', new Error('thrown'));

    expect(onError).toHaveBeenCalledWith('unhandledRejection', reason);
    expect(onError).toHaveBeenCalledWith('uncaughtException', expect.objectContaining({ message: 'thrown' }));

    uninstall();
    process.emit('unhandledRejection', reason, Promise.resolve());
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
