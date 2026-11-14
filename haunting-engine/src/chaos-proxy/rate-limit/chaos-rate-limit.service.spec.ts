import type { Clock } from '../../config/config.module';
import type { EngineConfig } from '../../config/engine-config';
import { ChaosRateLimitService, SWEEP_THRESHOLD } from './chaos-rate-limit.service';

// Requirements: 9.1, 9.2, 9.5, 9.12

const MAX = 3;
const WINDOW_SECONDS = 60;
const WINDOW_MS = WINDOW_SECONDS * 1000;

/** Controllable clock: tests move time by hand. */
class FakeClock implements Clock {
  constructor(private current = 1_000_000) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

function makeService(clock: Clock): ChaosRateLimitService {
  // Only `chaosRateLimit` is read by the service, so a partial config is cast.
  const config = { chaosRateLimit: { max: MAX, windowSeconds: WINDOW_SECONDS } } as EngineConfig;
  return new ChaosRateLimitService(config, clock);
}

/** Reads the private map size; the sweep bound is only observable there. */
function keyCount(service: ChaosRateLimitService): number {
  return (service as unknown as { hits: Map<string, number[]> }).hits.size;
}

function timestampsOf(service: ChaosRateLimitService, key: string): number[] | undefined {
  return (service as unknown as { hits: Map<string, number[]> }).hits.get(key);
}

describe('ChaosRateLimitService', () => {
  let clock: FakeClock;
  let service: ChaosRateLimitService;

  beforeEach(() => {
    clock = new FakeClock();
    service = makeService(clock);
  });

  it('allows MAX requests from one key and rejects the next', () => {
    for (let i = 0; i < MAX; i++) {
      expect(service.reserve('a').ok).toBe(true);
    }
    const result = service.reserve('a');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Number.isInteger(result.retryAfterSeconds)).toBe(true);
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_SECONDS);
    }
  });

  it('allows requests again once the window has passed', () => {
    for (let i = 0; i < MAX; i++) {
      service.reserve('a');
    }
    expect(service.reserve('a').ok).toBe(false);
    clock.advance(WINDOW_MS);
    expect(service.reserve('a').ok).toBe(true);
  });

  it('keeps keys independent', () => {
    for (let i = 0; i < MAX; i++) {
      service.reserve('a');
    }
    expect(service.reserve('a').ok).toBe(false);
    expect(service.reserve('b').ok).toBe(true);
  });

  it('restores exactly one slot on refund', () => {
    const reservations = [];
    for (let i = 0; i < MAX; i++) {
      const r = service.reserve('a');
      if (r.ok) {
        reservations.push(r.reservation);
      }
      clock.advance(10);
    }
    expect(service.reserve('a').ok).toBe(false);

    service.refund(reservations[1]);
    expect(service.reserve('a').ok).toBe(true);
    expect(service.reserve('a').ok).toBe(false);
  });

  it('removes only one occurrence when two reservations share a timestamp', () => {
    const first = service.reserve('a');
    service.reserve('a');
    if (!first.ok) {
      throw new Error('expected first reserve to succeed');
    }
    service.refund(first.reservation);
    expect(timestampsOf(service, 'a')).toHaveLength(1);
  });

  it('ignores a refund for an unknown key or timestamp', () => {
    service.reserve('a');
    service.refund({ key: 'nobody', timestamp: 1 });
    service.refund({ key: 'a', timestamp: 1 });
    expect(timestampsOf(service, 'a')).toHaveLength(1);
  });

  it('deletes the key when its last reservation is refunded', () => {
    const r = service.reserve('a');
    if (!r.ok) {
      throw new Error('expected reserve to succeed');
    }
    service.refund(r.reservation);
    expect(keyCount(service)).toBe(0);
  });

  it('does not add a timestamp when reserve is rejected', () => {
    for (let i = 0; i < MAX; i++) {
      service.reserve('a');
    }
    const before = [...(timestampsOf(service, 'a') ?? [])];
    clock.advance(1000);
    expect(service.reserve('a').ok).toBe(false);
    expect(service.reserve('a').ok).toBe(false);
    expect(timestampsOf(service, 'a')).toEqual(before);
  });

  it('sweeps expired keys once the map passes the threshold', () => {
    for (let i = 0; i <= SWEEP_THRESHOLD; i++) {
      service.reserve(`k${i}`);
    }
    // All keys are still inside the window, so nothing can be swept yet.
    expect(keyCount(service)).toBe(SWEEP_THRESHOLD + 1);

    clock.advance(WINDOW_MS);
    service.reserve('fresh');
    expect(keyCount(service)).toBe(1);
    expect(timestampsOf(service, 'fresh')).toHaveLength(1);
  });
});
