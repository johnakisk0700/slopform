import {
  BadRequestException,
  Body,
  Controller,
  createParamDecorator,
  Delete,
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

import { CurrentUserId } from "../../../infrastructure/auth/current-user-id.decorator.js";
import {
  CorrelationIdDto,
  PrincipalDto,
} from "../../../infrastructure/auth/auth.schemas.js";
import { FeedbackConversationNotFoundError } from "../post-event-feedback-conversation.repository.js";
import { FeedbackCampaignNotFoundError } from "../campaign/campaign.service.js";
import {
  AddFeedbackConversationNoteDto,
  CloseFeedbackConversationDto,
  CorrectFeedbackConversationAnswerDto,
  FeedbackAnswerIdParamDto,
  FeedbackAnswerViewDto,
  FeedbackAnswerWithdrawalDto,
  FeedbackAttentionReasonIdParamDto,
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
} from "./conversation.schemas.js";
import {
  FeedbackAnswerNotFoundError,
  FeedbackAttentionReasonNotFoundError,
  FeedbackConversationActionNotAllowedError,
  FeedbackNoteNotFoundError,
  PostEventFeedbackConversationService,
} from "./conversation.service.js";

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
    @Body() input: CloseFeedbackConversationDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackConversationDetailDto> {
    return mapConversationErrors(
      this.conversations.close(
        parameters.campaignId,
        parameters.conversationId,
        input,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Post(
    ":campaignId/conversations/:conversationId/attention-reasons/:reasonId/resolve",
  )
  @ApiOperation({ operationId: "resolveFeedbackConversationAttentionReason" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackConversationDetailDto })
  resolveAttentionReason(
    @Param() parameters: FeedbackAttentionReasonIdParamDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackConversationDetailDto> {
    return mapConversationErrors(
      this.conversations.resolveAttentionReason(
        parameters.campaignId,
        parameters.conversationId,
        parameters.reasonId,
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

  /**
   * Correcting a recorded score. `PATCH` because it changes one field of an
   * existing row, which is the shape the note review status already uses for a
   * human adjudicating model output.
   *
   * Not capability-gated: a closed conversation is the case this exists for,
   * since nothing will ever re-read it.
   */
  @Patch(":campaignId/conversations/:conversationId/answers/:answerId")
  @ApiOperation({ operationId: "correctFeedbackConversationAnswer" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackAnswerViewDto })
  correctAnswer(
    @Param() parameters: FeedbackAnswerIdParamDto,
    @Body() input: CorrectFeedbackConversationAnswerDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackAnswerViewDto> {
    return mapConversationErrors(
      this.conversations.correctAnswerValue(
        parameters.campaignId,
        parameters.conversationId,
        parameters.answerId,
        input,
        String(userId),
        String(correlationId),
      ),
    );
  }

  /**
   * Withdrawing an answer recorded about the wrong person. A separate verb from
   * the correction above because it is a separate assertion: not "this number is
   * wrong" but "this claim about somebody should not exist".
   */
  @Delete(":campaignId/conversations/:conversationId/answers/:answerId")
  @ApiOperation({ operationId: "withdrawFeedbackConversationAnswer" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackAnswerWithdrawalDto })
  withdrawAnswer(
    @Param() parameters: FeedbackAnswerIdParamDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackAnswerWithdrawalDto> {
    return mapConversationErrors(
      this.conversations.withdrawAnswer(
        parameters.campaignId,
        parameters.conversationId,
        parameters.answerId,
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
      error instanceof FeedbackNoteNotFoundError ||
      error instanceof FeedbackAnswerNotFoundError ||
      error instanceof FeedbackAttentionReasonNotFoundError
    ) {
      throw new NotFoundException(error.message, { cause: error });
    }
    if (error instanceof FeedbackConversationActionNotAllowedError) {
      throw new BadRequestException(error.message, { cause: error });
    }
    throw error;
  }
}
