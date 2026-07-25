import {
  Body,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Get,
  Header,
  NotFoundException,
  Param,
  Patch,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodResponse } from "nestjs-zod";

import { CurrentUserId } from "../../infrastructure/auth/current-user-id.decorator.js";
import {
  ParticipantCorrelationIdDto,
  ParticipantDto,
  ParticipantEventHistoryDto,
  ParticipantIdDto,
  ParticipantListDto,
  ParticipantPrincipalDto,
  UpdateParticipantFeedbackOptInDto,
} from "./participants.schemas.js";
import {
  ParticipantProfileNotFoundError,
  ParticipantsService,
} from "./participants.service.js";

type RequestWithId = Request & { id: string };
const RequestCorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<RequestWithId>().id,
);

@ApiTags("participants")
@Controller("participants")
export class ParticipantsController {
  constructor(private readonly participants: ParticipantsService) {}

  @Get()
  @ApiOperation({ operationId: "listParticipants" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: ParticipantListDto })
  list(
    @CurrentUserId() _userId: ParticipantPrincipalDto,
  ): Promise<ParticipantListDto> {
    return this.participants.list();
  }

  @Get(":id")
  @ApiOperation({ operationId: "getParticipant" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: ParticipantDto })
  get(
    @Param() parameters: ParticipantIdDto,
    @CurrentUserId() _userId: ParticipantPrincipalDto,
  ): Promise<ParticipantDto> {
    return mapParticipantErrors(this.participants.get(parameters.id));
  }

  @Get(":id/events")
  @ApiOperation({ operationId: "listParticipantEvents" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: ParticipantEventHistoryDto })
  listEvents(
    @Param() parameters: ParticipantIdDto,
    @CurrentUserId() _userId: ParticipantPrincipalDto,
  ): Promise<ParticipantEventHistoryDto> {
    return mapParticipantErrors(this.participants.listEvents(parameters.id));
  }

  @Patch(":id/feedback-whatsapp-opt-in")
  @ApiOperation({ operationId: "updateParticipantFeedbackOptIn" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: ParticipantDto })
  updateFeedbackOptIn(
    @Param() parameters: ParticipantIdDto,
    @Body() input: UpdateParticipantFeedbackOptInDto,
    @CurrentUserId() userId: ParticipantPrincipalDto,
    @RequestCorrelationId() correlationId: ParticipantCorrelationIdDto,
  ): Promise<ParticipantDto> {
    return mapParticipantErrors(
      this.participants.updateFeedbackOptIn(
        parameters.id,
        input,
        String(userId),
        String(correlationId),
      ),
    );
  }
}

async function mapParticipantErrors<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof ParticipantProfileNotFoundError) {
      throw new NotFoundException(error.message, { cause: error });
    }
    throw error;
  }
}
