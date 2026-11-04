import { Controller, Post, Body } from '@nestjs/common';
import { CoreService } from './core.service';

/**
 * CoreController handles inbound HTTP traffic for the Orders service.
 *
 * All business logic lives in CoreService; this controller is responsible
 * only for mapping HTTP input to service calls and returning the result.
 *
 * Requirements: 1.2
 */
@Controller()
export class CoreController {
  constructor(private readonly coreService: CoreService) {}

  /**
   * Accepts an order forwarded by the Gateway and sends it on to the Payments
   * service via CoreService. Returns whatever Payments responds with.
   */
  @Post('order')
  async createOrder(@Body() body: unknown): Promise<unknown> {
    return this.coreService.processOrder(body);
  }
}
