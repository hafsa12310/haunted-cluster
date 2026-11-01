import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { METRICS_SERVICE_NAME } from './metrics.service';

/**
 * Unit tests for HealthController.
 *
 * Requirements covered: 8.1, 8.2
 *
 * The controller receives its `serviceName` via the `METRICS_SERVICE_NAME`
 * injection token. Tests verify the correct response shape is returned and
 * that no downstream calls are made.
 */
describe('HealthController', () => {
  // ── Requirement 8.1 — response shape ─────────────────────────────────────

  describe('Requirement 8.1 — GET /health returns { status: "ok", service: <name> }', () => {
    it('returns status "ok" and the configured service name for "gateway"', async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          { provide: METRICS_SERVICE_NAME, useValue: 'gateway' },
        ],
      }).compile();

      const controller = module.get(HealthController);
      const result = controller.getHealth();

      expect(result).toEqual({ status: 'ok', service: 'gateway' });
    });

    it('returns status "ok" and the configured service name for "orders"', async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          { provide: METRICS_SERVICE_NAME, useValue: 'orders' },
        ],
      }).compile();

      const controller = module.get(HealthController);
      const result = controller.getHealth();

      expect(result).toEqual({ status: 'ok', service: 'orders' });
    });

    it('returns status "ok" and the configured service name for "payments"', async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          { provide: METRICS_SERVICE_NAME, useValue: 'payments' },
        ],
      }).compile();

      const controller = module.get(HealthController);
      const result = controller.getHealth();

      expect(result).toEqual({ status: 'ok', service: 'payments' });
    });

    it('always sets status to "ok" regardless of the service name', async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          { provide: METRICS_SERVICE_NAME, useValue: 'any-service' },
        ],
      }).compile();

      const controller = module.get(HealthController);
      const result = controller.getHealth();

      expect(result.status).toBe('ok');
    });

    it('reflects the exact service name injected — does not hardcode it', async () => {
      const uniqueName = 'unique-service-xyz';

      const module: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          { provide: METRICS_SERVICE_NAME, useValue: uniqueName },
        ],
      }).compile();

      const controller = module.get(HealthController);
      const result = controller.getHealth();

      expect(result.service).toBe(uniqueName);
    });
  });

  // ── Requirement 8.2 — no downstream calls ────────────────────────────────

  describe('Requirement 8.2 — /health does not call any downstream service', () => {
    it('completes synchronously without any async operations or HTTP calls', async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          { provide: METRICS_SERVICE_NAME, useValue: 'gateway' },
        ],
      }).compile();

      const controller = module.get(HealthController);

      // getHealth() must return a plain object, not a Promise — proving it
      // makes no async/downstream calls.
      const result = controller.getHealth();

      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof result).toBe('object');
    });

    it('does not call any injected HTTP client or external service', async () => {
      // If the controller had a downstream dependency it would need to be
      // provided here; attempting to compile without it would throw.
      // Providing ONLY the service name token confirms no other dependency exists.
      let compilationError: Error | null = null;

      try {
        const module: TestingModule = await Test.createTestingModule({
          controllers: [HealthController],
          providers: [
            { provide: METRICS_SERVICE_NAME, useValue: 'gateway' },
            // Deliberately no HTTP module, no downstream service — must still work.
          ],
        }).compile();

        const controller = module.get(HealthController);
        controller.getHealth(); // must not throw
      } catch (err) {
        compilationError = err as Error;
      }

      expect(compilationError).toBeNull();
    });
  });
});
