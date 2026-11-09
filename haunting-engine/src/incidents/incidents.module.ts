import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { IncidentsController } from './incidents.controller';

/** `GET /api/incidents`, read from EngineStateService. */
@Module({
  imports: [EngineModule],
  controllers: [IncidentsController],
})
export class IncidentsModule {}
