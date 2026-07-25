import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Get,
  Header,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodResponse } from "nestjs-zod";

import { CurrentUserId } from "../../infrastructure/auth/current-user-id.decorator.js";
import {
  CreateEventDto,
  EventAttendeeDto,
  EventAttendeeIdDto,
  EventCorrelationIdDto,
  EventDetailDto,
  EventDto,
  EventIdDto,
  EventListDto,
  EventPrincipalDto,
  FeedbackCandidatesDto,
  FeedbackCandidatesQueryDto,
  TransitionEventStatusDto,
  UpdateEventAttendeeDto,
  UpdateEventDto,
  UpsertEventAttendeeDto,
} from "./events.schemas.js";
import {
  EventAttendeeConflictError,
  EventAttendeeNotFoundError,
  EventMutationNotAllowedError,
  EventNotFoundError,
  EventStatusTransitionError,
  EventsService,
  ParticipantNotFoundError,
} from "./events.service.js";

type RequestWithId = Request & { id: string };
const RequestCorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<RequestWithId>().id,
);

@ApiTags("events")
@Controller("events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 201, type: EventDto })
  create(
    @Body() input: CreateEventDto,
    @CurrentUserId() userId: EventPrincipalDto,
    @RequestCorrelationId() correlationId: EventCorrelationIdDto,
  ): Promise<EventDto> {
    return mapEventErrors(
      this.events.create(input, String(userId), String(correlationId)),
    );
  }

  @Get()
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: EventListDto })
  list(@CurrentUserId() _userId: EventPrincipalDto): Promise<EventListDto> {
    return this.events.list();
  }

  @Get(":id")
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: EventDetailDto })
  get(
    @Param() parameters: EventIdDto,
    @CurrentUserId() _userId: EventPrincipalDto,
  ): Promise<EventDetailDto> {
    return mapEventErrors(this.events.get(parameters.id));
  }

  @Patch(":id")
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: EventDto })
  update(
    @Param() parameters: EventIdDto,
    @Body() input: UpdateEventDto,
    @CurrentUserId() userId: EventPrincipalDto,
    @RequestCorrelationId() correlationId: EventCorrelationIdDto,
  ): Promise<EventDto> {
    return mapEventErrors(
      this.events.update(
        parameters.id,
        input,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Post(":id/status")
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: EventDto })
  transitionStatus(
    @Param() parameters: EventIdDto,
    @Body() input: TransitionEventStatusDto,
    @CurrentUserId() userId: EventPrincipalDto,
    @RequestCorrelationId() correlationId: EventCorrelationIdDto,
  ): Promise<EventDto> {
    return mapEventErrors(
      this.events.transitionStatus(
        parameters.id,
        input,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Get(":id/feedback-candidates")
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackCandidatesDto })
  listFeedbackCandidates(
    @Param() parameters: EventIdDto,
    @Query() query: FeedbackCandidatesQueryDto,
    @CurrentUserId() _userId: EventPrincipalDto,
  ): Promise<FeedbackCandidatesDto> {
    return mapEventErrors(
      this.events.listFeedbackCandidatesForRespondent(
        parameters.id,
        query.respondentParticipantId,
      ),
    );
  }

  @Post(":id/attendees")
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 201, type: EventAttendeeDto })
  addAttendee(
    @Param() parameters: EventIdDto,
    @Body() input: UpsertEventAttendeeDto,
    @CurrentUserId() userId: EventPrincipalDto,
    @RequestCorrelationId() correlationId: EventCorrelationIdDto,
  ): Promise<EventAttendeeDto> {
    return mapEventErrors(
      this.events.upsertAttendee(
        parameters.id,
        input,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Put(":id/attendees/:attendeeId")
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: EventAttendeeDto })
  updateAttendee(
    @Param() parameters: EventAttendeeIdDto,
    @Body() input: UpdateEventAttendeeDto,
    @CurrentUserId() userId: EventPrincipalDto,
    @RequestCorrelationId() correlationId: EventCorrelationIdDto,
  ): Promise<EventAttendeeDto> {
    return mapEventErrors(
      this.events.updateAttendee(
        parameters.id,
        parameters.attendeeId,
        input,
        String(userId),
        String(correlationId),
      ),
    );
  }
}

async function mapEventErrors<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (
      error instanceof EventNotFoundError ||
      error instanceof EventAttendeeNotFoundError ||
      error instanceof ParticipantNotFoundError
    ) {
      throw new NotFoundException(error.message, { cause: error });
    }
    if (error instanceof EventAttendeeConflictError) {
      throw new ConflictException(error.message, { cause: error });
    }
    if (
      error instanceof EventStatusTransitionError ||
      error instanceof EventMutationNotAllowedError
    ) {
      throw new BadRequestException(error.message, { cause: error });
    }
    throw error;
  }
}
