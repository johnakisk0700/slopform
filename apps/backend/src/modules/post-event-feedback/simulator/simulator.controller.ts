import {
  Controller,
  BadRequestException,
  ConflictException,
  createParamDecorator,
  type ExecutionContext,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  Body,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodResponse } from "nestjs-zod";

import { CorrelationIdDto } from "../../../infrastructure/auth/auth.schemas.js";
import { PostEventFeedbackEnqueueError } from "../ingress/ingress.service.js";
import {
  FeedbackSimulatorRunNotFoundError,
  FeedbackSimulatorRunRejectedError,
  FeedbackSimulatorScenarioNotFoundError,
  FeedbackSimulatorService,
} from "./simulator.service.js";
import {
  FeedbackSimulatorCatalogResponseDto,
  FeedbackSimulatorPreflightDto,
  FeedbackSimulatorPreflightResponseDto,
  FeedbackSimulatorRunParamDto,
  FeedbackSimulatorRunResponseDto,
  FeedbackSimulatorThreadQueryDto,
  FeedbackSimulatorThreadResponseDto,
  InjectFeedbackSimulatorMessageDto,
  InjectFeedbackSimulatorMessageResponseDto,
  StartFeedbackSimulatorRunDto,
} from "./simulator.schemas.js";

type RequestWithId = Request & { id: string };
const RequestCorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<RequestWithId>().id,
);

@ApiTags("dev-feedback-simulator")
@Controller("dev/feedback/simulator")
export class FeedbackSimulatorController {
  constructor(private readonly simulator: FeedbackSimulatorService) {}

  @Get("catalog")
  @ApiOperation({ operationId: "getFeedbackSimulatorCatalog" })
  @ZodResponse({ status: 200, type: FeedbackSimulatorCatalogResponseDto })
  getCatalog(): FeedbackSimulatorCatalogResponseDto {
    return this.simulator.getCatalog();
  }

  @Post("preflight")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "preflightFeedbackSimulatorRun" })
  @ZodResponse({ status: 200, type: FeedbackSimulatorPreflightResponseDto })
  async preflightRun(
    @Body() body: FeedbackSimulatorPreflightDto,
    @RequestCorrelationId() requestId: CorrelationIdDto,
  ): Promise<FeedbackSimulatorPreflightResponseDto> {
    try {
      return await this.simulator.preflightScenarioRun(
        {
          campaignId: body.campaignId,
          conversationId: body.conversationId,
          scenarioId: body.scenarioId,
          expectedModel: body.expectedModel,
        },
        String(requestId),
      );
    } catch (error) {
      if (error instanceof FeedbackSimulatorScenarioNotFoundError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof FeedbackSimulatorRunRejectedError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Post("runs")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: "startFeedbackSimulatorRun" })
  @ZodResponse({ status: 202, type: FeedbackSimulatorRunResponseDto })
  async startRun(
    @Body() body: StartFeedbackSimulatorRunDto,
    @RequestCorrelationId() requestId: CorrelationIdDto,
  ): Promise<FeedbackSimulatorRunResponseDto> {
    try {
      return await this.simulator.startScenarioRun(
        {
          campaignId: body.campaignId,
          conversationId: body.conversationId,
          scenarioId: body.scenarioId,
          expectedModel: body.expectedModel,
          confirmPaidRun: body.confirmPaidRun,
        },
        String(requestId),
      );
    } catch (error) {
      if (error instanceof FeedbackSimulatorScenarioNotFoundError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof FeedbackSimulatorRunRejectedError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Get("runs/:runId")
  @ApiOperation({ operationId: "getFeedbackSimulatorRun" })
  @ZodResponse({ status: 200, type: FeedbackSimulatorRunResponseDto })
  async getRun(
    @Param() params: FeedbackSimulatorRunParamDto,
  ): Promise<FeedbackSimulatorRunResponseDto> {
    try {
      return await this.simulator.getScenarioRun(params.runId);
    } catch (error) {
      if (error instanceof FeedbackSimulatorRunNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  @Post("inject")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "injectFeedbackSimulatorMessage" })
  @ZodResponse({ status: 200, type: InjectFeedbackSimulatorMessageResponseDto })
  async inject(
    @Body() body: InjectFeedbackSimulatorMessageDto,
    @RequestCorrelationId() requestId: CorrelationIdDto,
  ): Promise<InjectFeedbackSimulatorMessageResponseDto> {
    try {
      return await this.simulator.injectObservedMessage(
        {
          phoneE164: body.phoneE164,
          text: body.text,
          fromMe: body.fromMe ?? false,
        },
        String(requestId),
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
