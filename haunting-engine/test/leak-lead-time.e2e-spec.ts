/**
 * Unit tests for the pure helpers in leak-lead-time.ts. Needs no running stack.
 *
 * Requirements: R14.4, R14.5, R14.6, R14.11
 */

import type { ClusterSnapshot, ServiceStatus } from '@haunted-cluster/shared';

import {
  computeLeadSeconds,
  isCrashSnapshot,
  isRestartSnapshot,
  parseIntegrationSettings,
} from './leak-lead-time';

function snap(status: ServiceStatus, rssMb: number | null): ClusterSnapshot {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    metricsAvailable: true,
    services: [
      {
        service: 'payments',
        status,
        score: 100,
        signals: { requestRate: 1, errorRatio: 0, latencyP95Ms: 10, rssMb, up: status !== 'down' },
        badness: { latency: 0, errors: 0, memory: 0 },
        breachedKinds: [],
      },
    ],
    dread: 0,
    anomalies: [],
    forecasts: [],
  };
}

describe('parseIntegrationSettings', () => {
  it('uses defaults when unset', () => {
    expect(parseIntegrationSettings({})).toEqual({ leakTimeoutSeconds: 300, minLeadSeconds: 10 });
  });

  it('reads valid overrides', () => {
    expect(
      parseIntegrationSettings({
        INTEGRATION_LEAK_TIMEOUT_SECONDS: '120',
        INTEGRATION_MIN_LEAD_SECONDS: '5',
      }),
    ).toEqual({ leakTimeoutSeconds: 120, minLeadSeconds: 5 });
  });

  it.each(['0', '-1', '1.5', 'abc', '', '01', ' 5'])('rejects "%s" naming the variable', (bad) => {
    expect(() => parseIntegrationSettings({ INTEGRATION_LEAK_TIMEOUT_SECONDS: bad })).toThrow(
      'INTEGRATION_LEAK_TIMEOUT_SECONDS',
    );
    expect(() => parseIntegrationSettings({ INTEGRATION_MIN_LEAD_SECONDS: bad })).toThrow(
      'INTEGRATION_MIN_LEAD_SECONDS',
    );
  });
});

describe('isCrashSnapshot', () => {
  it('detects payments down', () => {
    expect(isCrashSnapshot(snap('down', null), null, 256, 20)).toBe(true);
  });

  it('detects RSS at or above the limit', () => {
    expect(isCrashSnapshot(snap('critical', 256), 256, 256, 20)).toBe(true);
    expect(isCrashSnapshot(snap('critical', 255), 255, 256, 20)).toBe(false);
  });

  it('detects an RSS drop of more than the restart drop', () => {
    expect(isCrashSnapshot(snap('healthy', 79), 100, 256, 20)).toBe(true);
    expect(isCrashSnapshot(snap('healthy', 80), 100, 256, 20)).toBe(false);
  });

  it('is false with no RSS or no payments service', () => {
    expect(isCrashSnapshot(snap('healthy', null), 200, 256, 20)).toBe(false);
    expect(isCrashSnapshot({ ...snap('healthy', 80), services: [] }, 200, 256, 20)).toBe(false);
  });
});

describe('isRestartSnapshot', () => {
  it('detects payments down and an RSS drop of more than the restart drop', () => {
    expect(isRestartSnapshot(snap('down', null), null, 20)).toBe(true);
    expect(isRestartSnapshot(snap('healthy', 79), 100, 20)).toBe(true);
    expect(isRestartSnapshot(snap('healthy', 80), 100, 20)).toBe(false);
  });

  it('ignores RSS above the limit while the process is still alive', () => {
    expect(isRestartSnapshot(snap('critical', 290), 289, 20)).toBe(false);
    expect(isRestartSnapshot(snap('critical', 290), null, 20)).toBe(false);
  });

  it('is false with no RSS or no payments service', () => {
    expect(isRestartSnapshot(snap('healthy', null), 200, 20)).toBe(false);
    expect(isRestartSnapshot({ ...snap('healthy', 80), services: [] }, 200, 20)).toBe(false);
  });
});

describe('computeLeadSeconds', () => {
  it('returns crash minus warning in seconds', () => {
    expect(computeLeadSeconds('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:52.500Z')).toBe(52.5);
  });

  it('throws on an unparsable timestamp', () => {
    expect(() => computeLeadSeconds('nope', '2026-01-01T00:00:00.000Z')).toThrow('warning');
  });
});
