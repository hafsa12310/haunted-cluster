import { Controller, Post, Body } from '@nestjs/common';
import { CoreService } from './core.service';

/**
 * CoreController handles inbound HTTP traffic for the Gateway service.
 *
 * All business logic lives in CoreService; this controller is responsible
 * only for mapping HTTP input to service calls and returning the result.
 *
 * Requirements: 1.1
 */
@Controller()
export class CoreController {
  constructor(private readonly coreService: CoreService) {}

  /**
   * Accepts an order creation request and forwards it to the Orders service
   * via CoreService. Returns whatever Orders responds with.
   */
  @Post('order')
  async createOrder(@Body() body: unknown): Promise<unknown> {
    return this.coreService.processOrder(body);
  }
}
