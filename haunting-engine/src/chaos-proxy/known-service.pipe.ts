import { Inject, Injectable, NotFoundException, PipeTransform } from '@nestjs/common';
import type { ServiceName } from '@haunted-cluster/shared';
import { ENGINE_CONFIG } from '../config/config.module';
import type { EngineConfig } from '../config/engine-config';

/**
 * Lets `:service` through only if it is in SERVICE_CHAIN, so an unknown name
 * gets a 404 before any victim service is called.
 *
 * Requirements: 7.3
 */
@Injectable()
export class KnownServicePipe implements PipeTransform<string, ServiceName> {
  constructor(@Inject(ENGINE_CONFIG) private readonly config: EngineConfig) {}

  transform(value: string): ServiceName {
    if (!this.config.serviceChain.includes(value)) {
      // An object body, so the response is exactly { message } (design.md, Error Handling).
      throw new NotFoundException({ message: `unknown service: ${value}` });
    }
    return value;
  }
}
