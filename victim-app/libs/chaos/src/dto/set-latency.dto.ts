import { IsInt, Max, Min } from 'class-validator';

export class SetLatencyDto {
  @IsInt()
  @Min(0)
  @Max(30000)
  ms: number;
}
