import {
  BadRequestException,
  Body,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Get,
  Header,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodResponse } from "nestjs-zod";

import { CurrentUserId } from "../../infrastructure/auth/current-user-id.decorator.js";
import {
  CorrelationIdDto,
  PrincipalDto,
} from "../../infrastructure/auth/auth.schemas.js";
import { FeedbackConversationNotFoundError } from "../conversations/feedback-conversation.repository.js";
import { FeedbackCampaignNotFoundError } from "./post-event-feedback-campaign.service.js";
import {
  AddFeedbackConversationNoteDto,
  FeedbackCampaignConversationsDto,
  FeedbackCampaignIdParamDto,
  FeedbackCampaignResultsQueryDto,
  FeedbackConversationDetailDto,
  FeedbackConversationIdParamDto,
  FeedbackConversationResultsDto,
  FeedbackNoteIdParamDto,
  FeedbackNoteViewDto,
  SendFeedbackStaffMessageDto,
  UpdateFeedbackNoteReviewStatusDto,
} from "./post-event-feedback-conversation.schemas.js";
import {
  FeedbackConversationActionNotAllowedError,
  FeedbackNoteNotFoundError,
  PostEventFeedbackConversationService,
} from "./post-event-feedback-conversation.service.js";

type RequestWithId = Request & { id: string };
const RequestCorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<RequestWithId>().id,
);

@ApiTags("feedback-conversations")
@Controller("feedback/campaigns")
export class PostEventFeedbackConversationController {
  constructor(
    private readonly conversations: PostEventFeedbackConversationService,
  ) {}

  @Get(":campaignId/conversations")
  @ApiOperation({ operationId: "listFeedbackCampaignConversations" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackCampaignConversationsDto })
  list(
    @Param() parameters: FeedbackCampaignIdParamDto,
    @CurrentUserId() _userId: PrincipalDto,
  ): Promise<FeedbackCampaignConversationsDto> {
    return mapConversationErrors(
      this.conversations.listForCampaign(parameters.campaignId),
    );
  }

  @Get(":campaignId/conversations/:conversationId")
  @ApiOperation({ operationId: "getFeedbackConversation" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackConversationDetailDto })
  get(
    @Param() parameters: FeedbackConversationIdParamDto,
    @CurrentUserId() _userId: PrincipalDto,
  ): Promise<FeedbackConversationDetailDto> {
    return mapConversationErrors(
      this.conversations.get(parameters.campaignId, parameters.conversationId),
    );
  }

  @Get(":campaignId/conversations/:conversationId/results")
  @ApiOperation({ operationId: "listFeedbackConversationResults" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackConversationResultsDto })
  listConversationResults(
    @Param() parameters: FeedbackConversationIdParamDto,
    @CurrentUserId() _userId: PrincipalDto,
  ): Promise<FeedbackConversationResultsDto> {
    return mapConversationErrors(
      this.conversations.listConversationResults(
        parameters.campaignId,
        parameters.conversationId,
      ),
    );
  }

  @Get(":campaignId/results")
  @ApiOperation({ operationId: "listFeedbackCampaignResults" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackConversationResultsDto })
  listCampaignResults(
    @Param() parameters: FeedbackCampaignIdParamDto,
    @Query() query: FeedbackCampaignResultsQueryDto,
    @CurrentUserId() _userId: PrincipalDto,
  ): Promise<FeedbackConversationResultsDto> {
    return mapConversationErrors(
      this.conversations.listCampaignResults(parameters.campaignId, query),
    );
  }

  @Post(":campaignId/conversations/:conversationId/take-over")
  @ApiOperation({ operationId: "takeOverFeedbackConversation" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackConversationDetailDto })
  takeOver(
    @Param() parameters: FeedbackConversationIdParamDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackConversationDetailDto> {
    return mapConversationErrors(
      this.conversations.takeOver(
        parameters.campaignId,
        parameters.conversationId,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Post(":campaignId/conversations/:conversationId/resume-bot")
  @ApiOperation({ operationId: "resumeFeedbackConversationBot" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackConversationDetailDto })
  resumeBot(
    @Param() parameters: FeedbackConversationIdParamDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackConversationDetailDto> {
    return mapConversationErrors(
      this.conversations.resumeBot(
        parameters.campaignId,
        parameters.conversationId,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Post(":campaignId/conversations/:conversationId/close")
  @ApiOperation({ operationId: "closeFeedbackConversation" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackConversationDetailDto })
  close(
    @Param() parameters: FeedbackConversationIdParamDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackConversationDetailDto> {
    return mapConversationErrors(
      this.conversations.close(
        parameters.campaignId,
        parameters.conversationId,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Post(":campaignId/conversations/:conversationId/messages")
  @ApiOperation({ operationId: "sendFeedbackConversationStaffMessage" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackConversationDetailDto })
  sendStaffMessage(
    @Param() parameters: FeedbackConversationIdParamDto,
    @Body() input: SendFeedbackStaffMessageDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackConversationDetailDto> {
    return mapConversationErrors(
      this.conversations.sendStaffMessage(
        parameters.campaignId,
        parameters.conversationId,
        input.text,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Post(":campaignId/conversations/:conversationId/notes")
  @ApiOperation({ operationId: "addFeedbackConversationNote" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 201, type: FeedbackNoteViewDto })
  addNote(
    @Param() parameters: FeedbackConversationIdParamDto,
    @Body() input: AddFeedbackConversationNoteDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackNoteViewDto> {
    return mapConversationErrors(
      this.conversations.addStaffNote(
        parameters.campaignId,
        parameters.conversationId,
        input,
        String(userId),
        String(correlationId),
      ),
    );
  }
}

@ApiTags("feedback-notes")
@Controller("feedback/notes")
export class PostEventFeedbackNoteController {
  constructor(
    private readonly conversations: PostEventFeedbackConversationService,
  ) {}

  @Patch(":noteId/review-status")
  @ApiOperation({ operationId: "updateFeedbackNoteReviewStatus" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackNoteViewDto })
  updateReviewStatus(
    @Param() parameters: FeedbackNoteIdParamDto,
    @Body() input: UpdateFeedbackNoteReviewStatusDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackNoteViewDto> {
    return mapConversationErrors(
      this.conversations.updateNoteReviewStatus(
        parameters.noteId,
        input.status,
        String(userId),
        String(correlationId),
      ),
    );
  }
}

async function mapConversationErrors<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (
      error instanceof FeedbackCampaignNotFoundError ||
      error instanceof FeedbackConversationNotFoundError ||
      error instanceof FeedbackNoteNotFoundError
    ) {
      throw new NotFoundException(error.message, { cause: error });
    }
    if (error instanceof FeedbackConversationActionNotAllowedError) {
      throw new BadRequestException(error.message, { cause: error });
    }
    throw error;
  }
}
