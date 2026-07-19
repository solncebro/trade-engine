import { FeederConnectionGuard } from '../src/core/FeederConnectionGuard';

describe('FeederConnectionGuard', () => {
  it('reports a channel as not frozen by default', () => {
    const guard = new FeederConnectionGuard();

    expect(guard.isChannelFrozen('30m')).toBe(false);
    expect(guard.getFrozenChannelList()).toEqual([]);
  });

  it('freezes and restores a single channel independently of others', () => {
    const guard = new FeederConnectionGuard();

    guard.markChannelFrozen('30m');

    expect(guard.isChannelFrozen('30m')).toBe(true);
    expect(guard.isChannelFrozen('5m')).toBe(false);
    expect(guard.getFrozenChannelList()).toEqual(['30m']);

    guard.markChannelRestored('30m');

    expect(guard.isChannelFrozen('30m')).toBe(false);
    expect(guard.getFrozenChannelList()).toEqual([]);
  });

  it('is idempotent on repeated freeze/restore', () => {
    const guard = new FeederConnectionGuard();

    guard.markChannelFrozen('30m');
    guard.markChannelFrozen('30m');

    expect(guard.getFrozenChannelList()).toEqual(['30m']);

    guard.markChannelRestored('30m');
    guard.markChannelRestored('30m');

    expect(guard.isChannelFrozen('30m')).toBe(false);
  });
});
