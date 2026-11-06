import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLOCK, Clock, ConfigModule, ENGINE_CONFIG } from './config.module';
import { EngineConfig, loadEngineConfig } from './engine-config';

const config = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});

/** Lives in a module that does not import ConfigModule, to prove it is global. */
@Injectable()
class Consumer {
  constructor(
    @Inject(ENGINE_CONFIG) readonly config: EngineConfig,
    @Inject(CLOCK) readonly clock: Clock,
  ) {}
}

@Module({ providers: [Consumer] })
class ConsumerModule {}

describe('ConfigModule', () => {
  it('provides ENGINE_CONFIG and CLOCK globally', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(config), ConsumerModule],
    }).compile();

    const consumer = moduleRef.get(Consumer);
    expect(consumer.config).toBe(config);

    const before = Date.now();
    const now = consumer.clock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
