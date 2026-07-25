import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import {
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";

import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { Public } from "../../infrastructure/auth/public.decorator.js";
import { QueueHealthService } from "../../infrastructure/queue/queue-health.service.js";
import { ConversationThreadRepository } from "../conversations/conversation-thread.repository.js";
import {
  LiveResponseDto,
  NotReadyResponseDto,
  ReadyResponseDto,
} from "./health.schemas.js";

@ApiTags("health")
@Public()
@Controller("health")
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly conversations: ConversationThreadRepository,
    private readonly queue: QueueHealthService,
  ) {}

  @Get("live")
  @ApiOperation({ operationId: "getLiveness" })
  @ZodResponse({ status: 200, type: LiveResponseDto })
  live(): LiveResponseDto {
    return { status: "ok", checkedAt: new Date().toISOString() };
  }

  @Get("ready")
  @ApiOperation({ operationId: "getReadiness" })
  @ZodResponse({ status: 200, type: ReadyResponseDto })
  @ApiServiceUnavailableResponse({ type: NotReadyResponseDto.Output })
  async ready(): Promise<ReadyResponseDto> {
    const checks = await Promise.allSettled([
      this.database.ping(),
      this.conversations.ping(),
      this.queue.ping(),
    ]);

    if (checks.some((check) => check.status === "rejected")) {
      throw new ServiceUnavailableException({
        status: "not_ready",
        checks: {
          database: checks[0]?.status === "fulfilled" ? "up" : "down",
          mongodb: checks[1]?.status === "fulfilled" ? "up" : "down",
          redis: checks[2]?.status === "fulfilled" ? "up" : "down",
        },
      });
    }

    return {
      status: "ready",
      checkedAt: new Date().toISOString(),
      checks: { database: "up", mongodb: "up", redis: "up" },
    };
  }
}
