import {
  Body,
  ConflictException,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Get,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodResponse } from "nestjs-zod";

import { CurrentUserId } from "../../infrastructure/auth/current-user-id.decorator.js";
import {
  CorrelationIdDto,
  PrincipalDto,
} from "../../infrastructure/auth/auth.schemas.js";
import {
  AssistantEnqueueError,
  AssistantJobsService,
} from "./assistant-jobs.service.js";
import {
  AssistantThreadDto,
  AssistantThreadIdDto,
  AssistantThreadListDto,
  AssistantTurnDto,
  AssistantTurnParametersDto,
  CreateAssistantThreadDto,
  CreateAssistantTurnDto,
} from "./assistant.schemas.js";
import {
  AssistantProviderUnavailableError,
  AssistantService,
  AssistantThreadNotFoundError,
  AssistantTurnConflictError,
  AssistantTurnNotFoundError,
} from "./assistant.service.js";

type RequestWithId = Request & { id: string };
const RequestCorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<RequestWithId>().id,
);

@ApiTags("assistant")
@Controller("assistant/threads")
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly jobs: AssistantJobsService,
  ) {}

  @Post()
  @ApiOperation({ operationId: "createAssistantThread" })
  @ZodResponse({ status: 201, type: AssistantThreadDto })
  createThread(
    @Body() input: CreateAssistantThreadDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<AssistantThreadDto> {
    return mapAssistantErrors(
      this.jobs.createThreadAndEnqueue(
        input,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Get()
  @ApiOperation({ operationId: "listAssistantThreads" })
  @ZodResponse({ status: 200, type: AssistantThreadListDto })
  list(@CurrentUserId() userId: PrincipalDto): Promise<AssistantThreadListDto> {
    return mapAssistantErrors(this.assistant.list(String(userId)));
  }

  @Get(":id")
  @ApiOperation({ operationId: "getAssistantThread" })
  @ZodResponse({ status: 200, type: AssistantThreadDto })
  getThread(
    @Param() parameters: AssistantThreadIdDto,
    @CurrentUserId() userId: PrincipalDto,
  ): Promise<AssistantThreadDto> {
    return mapAssistantErrors(
      this.assistant.getThread(parameters.id, String(userId)),
    );
  }

  @Post(":id/turns")
  @ApiOperation({ operationId: "createAssistantTurn" })
  @ZodResponse({ status: 201, type: AssistantTurnDto })
  appendTurn(
    @Param() parameters: AssistantThreadIdDto,
    @Body() input: CreateAssistantTurnDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<AssistantTurnDto> {
    return mapAssistantErrors(
      this.jobs.appendTurnAndEnqueue(
        parameters.id,
        input,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Get(":threadId/turns/:turnId")
  @ApiOperation({ operationId: "getAssistantTurn" })
  @ZodResponse({ status: 200, type: AssistantTurnDto })
  getTurn(
    @Param() parameters: AssistantTurnParametersDto,
    @CurrentUserId() userId: PrincipalDto,
  ): Promise<AssistantTurnDto> {
    return mapAssistantErrors(
      this.assistant.getTurn(
        parameters.threadId,
        parameters.turnId,
        String(userId),
      ),
    );
  }

  @Post(":threadId/turns/:turnId/retry")
  @ApiOperation({ operationId: "retryAssistantTurn" })
  @ZodResponse({ status: 201, type: AssistantTurnDto })
  retryTurn(
    @Param() parameters: AssistantTurnParametersDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<AssistantTurnDto> {
    return mapAssistantErrors(
      this.jobs.retryTurnAndEnqueue(
        parameters.threadId,
        parameters.turnId,
        String(userId),
        String(correlationId),
      ),
    );
  }
}

async function mapAssistantErrors<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (
      error instanceof AssistantThreadNotFoundError ||
      error instanceof AssistantTurnNotFoundError
    ) {
      throw new NotFoundException(error.message, { cause: error });
    }

    if (error instanceof AssistantTurnConflictError) {
      throw new ConflictException(error.message, { cause: error });
    }

    if (
      error instanceof AssistantProviderUnavailableError ||
      error instanceof AssistantEnqueueError
    ) {
      throw new ServiceUnavailableException(error.message, { cause: error });
    }

    throw error;
  }
}
