import {
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  ServiceUnavailableException,
  Body,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodResponse } from "nestjs-zod";

import { PostEventFeedbackEnqueueError } from "./post-event-feedback-ingress.service.js";
import { FeedbackSimulatorService } from "./feedback-simulator.service.js";
import {
  FeedbackSimulatorThreadQueryDto,
  FeedbackSimulatorThreadResponseDto,
  InjectFeedbackSimulatorMessageDto,
  InjectFeedbackSimulatorMessageResponseDto,
} from "./feedback-simulator.schemas.js";

type RequestWithId = Request & { id: string };
const RequestCorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<RequestWithId>().id,
);

@ApiTags("dev-feedback-simulator")
@Controller("dev/feedback/simulator")
export class FeedbackSimulatorController {
  constructor(private readonly simulator: FeedbackSimulatorService) {}

  @Post("inject")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "injectFeedbackSimulatorMessage" })
  @ZodResponse({ status: 200, type: InjectFeedbackSimulatorMessageResponseDto })
  async inject(
    @Body() body: InjectFeedbackSimulatorMessageDto,
    @RequestCorrelationId() requestId: string,
  ): Promise<InjectFeedbackSimulatorMessageResponseDto> {
    try {
      return await this.simulator.injectObservedMessage(
        {
          phoneE164: body.phoneE164,
          text: body.text,
          fromMe: body.fromMe ?? false,
        },
        requestId,
      );
    } catch (error) {
      if (error instanceof PostEventFeedbackEnqueueError) {
        throw new ServiceUnavailableException(
          "The observed message could not be queued",
        );
      }
      throw error;
    }
  }

  @Get("thread")
  @ApiOperation({ operationId: "getFeedbackSimulatorThread" })
  @ZodResponse({ status: 200, type: FeedbackSimulatorThreadResponseDto })
  getThread(
    @Query() query: FeedbackSimulatorThreadQueryDto,
  ): Promise<FeedbackSimulatorThreadResponseDto> {
    return this.simulator.getThreadByPhone(query.phoneE164);
  }
}
