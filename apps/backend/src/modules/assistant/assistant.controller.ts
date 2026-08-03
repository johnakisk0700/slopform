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
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
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
  type AssistantTurnView,
} from "./assistant.schemas.js";
import {
  AssistantStreamRelay,
  type AssistantStreamEvent,
} from "./assistant-stream.relay.js";
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
    private readonly streams: AssistantStreamRelay,
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

  @Get(":threadId/turns/:turnId/stream")
  @ApiOperation({ operationId: "streamAssistantTurn" })
  @ApiProduces("text/event-stream")
  @ApiOkResponse({
    description:
      "Best-effort live turn frames. Durable turn polling remains authoritative.",
    schema: { type: "string" },
  })
  async streamTurn(
    @Param() parameters: AssistantTurnParametersDto,
    @CurrentUserId() userId: PrincipalDto,
    @Res() response: Response,
  ): Promise<void> {
    // Authorize and capture the attempt before opening a long-lived response.
    // Every following frame is fenced with that attempt in the browser.
    const turn = await mapAssistantErrors(
      this.assistant.getTurn(
        parameters.threadId,
        parameters.turnId,
        String(userId),
      ),
    );
    const abort = new AbortController();
    const close = () => abort.abort();
    // The incoming GET request is complete before the SSE response is. The
    // response's `close` event is therefore the reliable client-disconnect
    // signal; binding this to the request can abort a healthy stream as soon as
    // Node finishes reading its empty request body.
    response.once("close", close);

    response.status(200);
    response.set({
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();

    const heartbeat = setInterval(() => {
      if (!abort.signal.aborted && !response.writableNeedDrain) {
        response.write(": keep-alive\n\n");
      }
    }, 15_000);

    try {
      await writeStreamFrame(response, {
        kind: "snapshot",
        attempt: turn.attempt,
        status: turn.status,
        accumulated: turn.partial,
        reasoning: turn.reasoning,
        toolCalls: turn.toolCalls,
      });

      if (turn.status === "succeeded" || turn.status === "failed") {
        await writeStreamFrame(response, {
          kind: "done",
          attempt: turn.attempt,
        });
        return;
      }

      for await (const event of this.streams.follow(
        turn.id,
        turn.attempt,
        abort.signal,
      )) {
        if (abort.signal.aborted) break;
        await writeStreamFrame(response, streamFrame(turn.attempt, event));
        if (event.kind === "done") break;
      }
    } catch {
      // The stream is an accelerator. Closing it lets the browser keep polling
      // the durable turn instead of turning a Redis outage into a failed answer.
    } finally {
      clearInterval(heartbeat);
      response.removeListener("close", close);
      if (!response.writableEnded) response.end();
    }
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

type AssistantSseFrame =
  | {
      readonly kind: "snapshot";
      readonly attempt: number;
      readonly status: AssistantTurnView["status"];
      readonly accumulated: string | null;
      readonly reasoning: string | null;
      readonly toolCalls: AssistantTurnView["toolCalls"];
    }
  | ({ readonly attempt: number } & AssistantStreamEvent);

function streamFrame(
  attempt: number,
  event: AssistantStreamEvent,
): AssistantSseFrame {
  return { attempt, ...event };
}

async function writeStreamFrame(
  response: Response,
  frame: AssistantSseFrame,
): Promise<void> {
  if (response.writableEnded) return;
  const accepted = response.write(`data: ${JSON.stringify(frame)}\n\n`);
  if (accepted) return;

  await new Promise<void>((resolve) => {
    const finish = () => {
      response.removeListener("drain", finish);
      response.removeListener("close", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
  });
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
