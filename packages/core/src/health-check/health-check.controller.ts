import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import { HEALTH_CHECK_ROUTE } from './constants';
import { HealthCheckRegistryService } from './health-check-registry.service';

/**
 * @deprecated The built-in health check endpoint is deprecated and will be removed in v4.0.0.
 * Use infrastructure-level health checks instead.
 */
@Controller(HEALTH_CHECK_ROUTE)
export class HealthController {
    constructor(
        private health: HealthCheckService,
        private healthCheckRegistryService: HealthCheckRegistryService,
    ) {}

    @Get()
    @HealthCheck()
    check() {
        return this.health.check(this.healthCheckRegistryService.healthIndicatorFunctions);
    }
}
