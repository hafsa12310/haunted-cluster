import type { ChaosEvent } from '@haunted-cluster/shared';
import { CHAOS_LOG_LIMIT, ChaosLogService } from './chaos-log.service';

const T0 = Date.parse('2026-11-08T12:00:00.000Z');

/** The `n`th event, one second after the previous one. */
function event(n: number): ChaosEvent {
  return {
    id: `chaos-${n}`,
    service: 'orders',
    action: 'latency',
    params: { ms: n },
    at: new Date(T0 + n * 1000).toISOString(),
  };
}

const ids = (events: ChaosEvent[]) => events.map((e) => e.id);

describe('ChaosLogService', () => {
  it('starts empty', () => {
    expect(new ChaosLogService().recent()).toEqual([]);
  });

  it('returns recorded events newest first', () => {
    const log = new ChaosLogService();
    log.record(event(1));
    log.record(event(2));
    log.record(event(3));

    expect(ids(log.recent())).toEqual(['chaos-3', 'chaos-2', 'chaos-1']);
  });

  it('keeps events unchanged', () => {
    const log = new ChaosLogService();
    const e = event(1);
    log.record(e);

    expect(log.recent()).toEqual([e]);
  });

  describe('limit (Requirement 8.2)', () => {
    it('is 100', () => {
      expect(CHAOS_LOG_LIMIT).toBe(100);
    });

    it('keeps all 100 events at the limit', () => {
      const log = new ChaosLogService();
      for (let n = 1; n <= 100; n++) log.record(event(n));

      const recent = log.recent();
      expect(recent).toHaveLength(100);
      expect(recent[0].id).toBe('chaos-100');
      expect(recent[99].id).toBe('chaos-1');
    });

    it('discards the oldest first beyond the limit', () => {
      const log = new ChaosLogService();
      for (let n = 1; n <= 250; n++) log.record(event(n));

      const recent = log.recent();
      expect(recent).toHaveLength(100);
      // The newest 100, events 250 down to 151.
      expect(ids(recent)).toEqual(Array.from({ length: 100 }, (_, i) => `chaos-${250 - i}`));
    });
  });

  it('returns a copy, so changing it does not change the log', () => {
    const log = new ChaosLogService();
    log.record(event(1));
    log.record(event(2));

    const recent = log.recent();
    recent.pop();
    recent.unshift(event(99));

    expect(ids(log.recent())).toEqual(['chaos-2', 'chaos-1']);
  });

  it('does not change an earlier result when more events are recorded', () => {
    const log = new ChaosLogService();
    log.record(event(1));
    const before = log.recent();

    log.record(event(2));

    expect(ids(before)).toEqual(['chaos-1']);
  });
});
