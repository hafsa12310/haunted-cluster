/**
 * Chaos TTL expiry test. ChaosService reads CHAOS_TTL_SECONDS once at startup
 * and the compose stack uses 120 s, so this suite boots its own Payments app
 * in-process with CHAOS_TTL_SECONDS=1 instead of using the running container.
 * Not part of `npm test`; run with `npm run test:e2e`.
 *
 * Requirements: 7.4
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { postJson } from './helpers';

describe('Chaos TTL expiry', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CHAOS_TTL_SECONDS = '1';
    // Imported after setting the env var so nothing reads it too early.
    const { AppModule } = await import('../apps/payments/src/app.module');

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.CHAOS_TTL_SECONDS;
  });

  it('latency on Payments resets to 0 after CHAOS_TTL_SECONDS', async () => {
    const chaosRes = await postJson(`${baseUrl}/chaos/latency`, { ms: 500 });
    expect(chaosRes.status).toBe(201);

    const before = await (await fetch(`${baseUrl}/chaos/state`)).json();
    expect(before.latencyMs).toBe(500);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const after = await (await fetch(`${baseUrl}/chaos/state`)).json();
    expect(after.latencyMs).toBe(0);
  });
});
