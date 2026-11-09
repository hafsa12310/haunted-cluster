import { Controller, Get } from '@nestjs/common';
import type { Incident } from '@haunted-cluster/shared';
import { EngineStateService } from '../engine/engine-state.service';

/** Requirements: 10.3 */
@Controller('api/incidents')
export class IncidentsController {
  constructor(private readonly state: EngineStateService) {}

  /** Open incidents in chain order; resolved incidents newest first. */
  @Get()
  incidents(): { open: Incident[]; resolved: Incident[] } {
    return { open: this.state.openIncidents(), resolved: this.state.resolvedIncidents() };
  }
}
