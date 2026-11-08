import { IsNumber, Max, Min } from 'class-validator';

/**
 * Body for `POST /api/chaos/:service/error-rate`. Same rules as the victim's
 * SetErrorRateDto.
 * Requirements: 7.2
 */
export class SetErrorRateDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  percentage: number;
}
