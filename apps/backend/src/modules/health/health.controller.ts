import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";

import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { QueueHealthService } from "../../infrastructure/queue/queue-health.service.js";
import { LiveResponseDto, ReadyResponseDto } from "./health.schemas.js";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly queue: QueueHealthService,
  ) {}

  @Get("live")
  @ZodResponse({ type: LiveResponseDto })
  live(): LiveResponseDto {
    return { status: "ok", checkedAt: new Date().toISOString() };
  }

  @Get("ready")
  @ZodResponse({ type: ReadyResponseDto })
  async ready(): Promise<ReadyResponseDto> {
    const checks = await Promise.allSettled([
      this.database.ping(),
      this.queue.ping(),
    ]);

    if (checks.some((check) => check.status === "rejected")) {
      throw new ServiceUnavailableException({
        status: "not_ready",
        checks: {
          database: checks[0]?.status === "fulfilled" ? "up" : "down",
          redis: checks[1]?.status === "fulfilled" ? "up" : "down",
        },
      });
    }

    return {
      status: "ready",
      checkedAt: new Date().toISOString(),
      checks: { database: "up", redis: "up" },
    };
  }
}
