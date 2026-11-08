import { IsBoolean } from 'class-validator';

/**
 * Body for `POST /api/chaos/:service/memory-leak`. Same rules as the victim's
 * SetMemoryLeakDto.
 * Requirements: 7.2
 */
export class SetMemoryLeakDto {
  @IsBoolean()
  enabled: boolean;
}
