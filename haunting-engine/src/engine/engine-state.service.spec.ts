import { initialTrackerState } from '../incidents/incident-tracker';
import { initialIntelligenceState } from '../intelligence/intelligence-step';
import { testEngineConfig } from '../intelligence/test-support';
import { EngineStateService } from './engine-state.service';

// Validates: Requirements R9.3, R10.4
describe('EngineStateService intelligence state', () => {
  it('starts with the initial intelligence state for the configured chain', () => {
    const config = testEngineConfig(['gateway', 'orders', 'payments']);
    const state = new EngineStateService(config);
    expect(state.intelligence).toEqual(initialIntelligenceState(config.serviceChain));
  });

  it('update replaces snapshot, tracker and intelligence together', () => {
    const config = testEngineConfig(['gateway', 'orders', 'payments']);
    const state = new EngineStateService(config);
    const tracker = initialTrackerState(config.serviceChain);
    const intelligence = initialIntelligenceState(config.serviceChain);
    const snapshot = {
      timestamp: '2026-11-08T12:00:00.000Z',
      metricsAvailable: true,
      services: [],
      dread: 0,
      anomalies: [],
      forecasts: [],
    };
    state.update(snapshot, tracker, intelligence);
    expect(state.latestSnapshot).toBe(snapshot);
    expect(state.tracker).toBe(tracker);
    expect(state.intelligence).toBe(intelligence);
  });
});
