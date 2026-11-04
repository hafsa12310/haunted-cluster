import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { isAxiosError } from 'axios';
import { mapDownstreamError } from '@app/common';

/**
 * CoreService handles outbound HTTP calls from the Gateway to downstream services.
 *
 * HttpService is provided by DownstreamHttpModule, which applies the configured
 * DOWNSTREAM_TIMEOUT_MS to every request and exports HttpModule.
 *
 * Requirements: 1.1, 1.4, 1.5, 1.6, 1.7
 */
@Injectable()
export class CoreService {
  constructor(private readonly httpService: HttpService) {}

  /**
   * Forwards an order creation request to the Orders service.
   *
   * POSTs to `${ORDERS_URL}/order` and returns the response body on success.
   * On AxiosError, delegates to mapDownstreamError to produce the appropriate
   * 502 or 504 HttpException, then rethrows it so the global exception filter
   * can serialise it to the caller.
   *
   * @param body - The order payload forwarded from the inbound request.
   * @returns The response data from the Orders service.
   */
  async processOrder(body: unknown): Promise<unknown> {
    const url = `${process.env.ORDERS_URL}/order`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<unknown>(url, body),
      );
      return response.data;
    } catch (error) {
      if (isAxiosError(error)) {
        throw mapDownstreamError(error, 'orders');
      }
      throw error;
    }
  }
}
