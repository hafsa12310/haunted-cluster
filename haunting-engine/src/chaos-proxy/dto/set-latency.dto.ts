import { IsInt, Max, Min } from 'class-validator';

/**
 * Body for `POST /api/chaos/:service/latency`. Same rules as the victim's
 * SetLatencyDto, so bad input is rejected before it reaches a victim service.
 * Requirements: 7.2
 */
export class SetLatencyDto {
  @IsInt()
  @Min(0)
  @Max(30000)
  ms: number;
}
