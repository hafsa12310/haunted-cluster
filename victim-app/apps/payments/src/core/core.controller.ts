import { Controller, Post } from '@nestjs/common';
import { CoreService, PaymentResponse } from './core.service';

/**
 * CoreController handles inbound HTTP traffic for the Payments service.
 *
 * All business logic lives in CoreService; this controller is responsible
 * only for mapping HTTP input to service calls and returning the result.
 *
 * Requirements: 1.3
 */
@Controller()
export class CoreController {
  constructor(private readonly coreService: CoreService) {}

  /**
   * Accepts a payment request forwarded by the Orders service and returns
   * `{ status: 'paid', orderId }`.
   */
  @Post('payment')
  createPayment(): PaymentResponse {
    return this.coreService.processPayment();
  }
}
