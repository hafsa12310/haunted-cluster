import { NotFoundException } from '@nestjs/common';
import { loadEngineConfig } from '../config/engine-config';
import { KnownServicePipe } from './known-service.pipe';

const pipe = new KnownServicePipe(
  loadEngineConfig({
    PROMETHEUS_URL: 'http://prometheus:9090',
    GATEWAY_URL: 'http://gateway:3000',
    ORDERS_URL: 'http://orders:3001',
    PAYMENTS_URL: 'http://payments:3002',
  }),
);

/** Runs the pipe, asserts it throws a NotFoundException, and returns it. */
function notFound(value: string): NotFoundException {
  try {
    pipe.transform(value);
  } catch (error) {
    expect(error).toBeInstanceOf(NotFoundException);
    return error as NotFoundException;
  }
  throw new Error(`expected a NotFoundException for "${value}"`);
}

describe('KnownServicePipe (Requirement 7.3)', () => {
  it.each(['gateway', 'orders', 'payments'])('lets %s through unchanged', (service) => {
    expect(pipe.transform(service)).toBe(service);
  });

  it('throws a 404 with { message: "unknown service: <name>" } for a name outside SERVICE_CHAIN', () => {
    const error = notFound('billing');

    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({ message: 'unknown service: billing' });
  });

  it.each([
    ['a different case', 'Orders'],
    ['surrounding whitespace', ' orders'],
    ['an empty name', ''],
    ['a prefix of a known name', 'order'],
    ['the reset-all route name', 'reset-all'],
    ['an Object.prototype key', 'constructor'],
  ])('rejects %s', (_label, value) => {
    expect(notFound(value).getResponse()).toEqual({ message: `unknown service: ${value}` });
  });

  it('follows a custom SERVICE_CHAIN', () => {
    const custom = new KnownServicePipe(
      loadEngineConfig({
        PROMETHEUS_URL: 'http://prometheus:9090',
        SERVICE_CHAIN: 'checkout-api,billing',
        CHECKOUT_API_URL: 'http://checkout-api:4000',
        BILLING_URL: 'http://billing:4001',
      }),
    );

    expect(custom.transform('billing')).toBe('billing');
    expect(() => custom.transform('orders')).toThrow(NotFoundException);
  });
});
