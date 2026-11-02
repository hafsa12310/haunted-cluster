import { IsBoolean } from 'class-validator';

export class SetMemoryLeakDto {
  @IsBoolean()
  enabled: boolean;
}
