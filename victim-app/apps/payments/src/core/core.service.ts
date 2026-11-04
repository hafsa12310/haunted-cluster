import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

export interface PaymentResponse {
  status: 'paid';
  orderId: string;
}

/**
 * CoreService handles payment processing for the Payments service.
 *
 * Payments is the end of the Gateway → Orders → Payments call chain, so it
 * makes no downstream calls; latency and errors here come only from chaos
 * injection.
 *
 * Requirements: 1.3
 */
@Injectable()
export class CoreService {
  /**
   * Marks the payment as paid and returns a freshly generated order ID.
   *
   * @returns `{ status: 'paid', orderId: <uuid v4> }`
   */
  processPayment(): PaymentResponse {
    return { status: 'paid', orderId: uuidv4() };
  }
}
