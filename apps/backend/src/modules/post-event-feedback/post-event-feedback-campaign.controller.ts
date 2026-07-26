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
  Post,
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
  FeedbackCampaignDto,
  FeedbackCampaignIdDto,
  FeedbackCampaignListDto,
  LaunchFeedbackCampaignDto,
  StartFeedbackConversationDto,
  StartFeedbackConversationResultDto,
} from "./post-event-feedback-campaign.schemas.js";
import {
  FeedbackCampaignEventNotFoundError,
  FeedbackCampaignLaunchNotAllowedError,
  FeedbackCampaignMutationNotAllowedError,
  FeedbackCampaignNotFoundError,
  FeedbackCampaignParticipantNotEligibleError,
  PostEventFeedbackCampaignService,
} from "./post-event-feedback-campaign.service.js";

type RequestWithId = Request & { id: string };
const RequestCorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<RequestWithId>().id,
);

@ApiTags("feedback-campaigns")
@Controller("feedback/campaigns")
export class PostEventFeedbackCampaignController {
  constructor(private readonly campaigns: PostEventFeedbackCampaignService) {}

  @Get()
  @ApiOperation({ operationId: "listFeedbackCampaigns" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackCampaignListDto })
  list(
    @CurrentUserId() _userId: PrincipalDto,
  ): Promise<FeedbackCampaignListDto> {
    return this.campaigns.list();
  }

  @Post("launch")
  @ApiOperation({ operationId: "launchFeedbackCampaign" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 201, type: FeedbackCampaignDto })
  launch(
    @Body() input: LaunchFeedbackCampaignDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackCampaignDto> {
    return mapCampaignErrors(
      this.campaigns.launch(
        input.eventId,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Get(":campaignId")
  @ApiOperation({ operationId: "getFeedbackCampaign" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackCampaignDto })
  get(
    @Param() parameters: FeedbackCampaignIdDto,
    @CurrentUserId() _userId: PrincipalDto,
  ): Promise<FeedbackCampaignDto> {
    return mapCampaignErrors(this.campaigns.get(parameters.campaignId));
  }

  @Post(":campaignId/pause")
  @ApiOperation({ operationId: "pauseFeedbackCampaign" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackCampaignDto })
  pause(
    @Param() parameters: FeedbackCampaignIdDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackCampaignDto> {
    return mapCampaignErrors(
      this.campaigns.pause(
        parameters.campaignId,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Post(":campaignId/resume")
  @ApiOperation({ operationId: "resumeFeedbackCampaign" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackCampaignDto })
  resume(
    @Param() parameters: FeedbackCampaignIdDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackCampaignDto> {
    return mapCampaignErrors(
      this.campaigns.resume(
        parameters.campaignId,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Post(":campaignId/close")
  @ApiOperation({ operationId: "closeFeedbackCampaign" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackCampaignDto })
  close(
    @Param() parameters: FeedbackCampaignIdDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<FeedbackCampaignDto> {
    return mapCampaignErrors(
      this.campaigns.close(
        parameters.campaignId,
        String(userId),
        String(correlationId),
      ),
    );
  }

  @Post(":campaignId/conversations/start")
  @ApiOperation({ operationId: "startFeedbackConversation" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 201, type: StartFeedbackConversationResultDto })
  startConversation(
    @Param() parameters: FeedbackCampaignIdDto,
    @Body() input: StartFeedbackConversationDto,
    @CurrentUserId() userId: PrincipalDto,
    @RequestCorrelationId() correlationId: CorrelationIdDto,
  ): Promise<StartFeedbackConversationResultDto> {
    return mapCampaignErrors(
      this.campaigns.startConversation(
        parameters.campaignId,
        input.participantId,
        String(userId),
        String(correlationId),
      ),
    );
  }
}

async function mapCampaignErrors<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (
      error instanceof FeedbackCampaignNotFoundError ||
      error instanceof FeedbackCampaignEventNotFoundError
    ) {
      throw new NotFoundException(error.message, { cause: error });
    }
    if (
      error instanceof FeedbackCampaignLaunchNotAllowedError ||
      error instanceof FeedbackCampaignMutationNotAllowedError ||
      error instanceof FeedbackCampaignParticipantNotEligibleError
    ) {
      throw new BadRequestException(error.message, { cause: error });
    }
    throw error;
  }
}
