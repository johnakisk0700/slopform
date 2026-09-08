import { Controller, Get, Header, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import { CurrentUserId } from "../../../infrastructure/auth/current-user-id.decorator.js";
import { PrincipalDto } from "../../../infrastructure/auth/auth.schemas.js";
import {
  TopicAnalysisCampaignParametersDto,
  TopicAnalysisParametersDto,
  TopicAnalysisResultDto,
  TopicAnalysisStatusDto,
} from "./topic-analysis.schemas.js";
import { TopicAnalysisService } from "./topic-analysis.service.js";

@ApiTags("feedback-topic-analysis")
@Controller("feedback/campaigns/:campaignId/topic-analyses")
export class TopicAnalysisController {
  constructor(private readonly analyses: TopicAnalysisService) {}

  @Post()
  @ApiOperation({
    operationId: "startFeedbackTopicAnalysis",
    summary: "Analyze an immutable snapshot of active extracted notes",
    description:
      "Admin only; requires FEEDBACK_TOPIC_ANALYSIS_ENABLED. Excludes dismissed, staff and deterministic fallback notes, answers and raw transcripts. Same snapshot/config returns the existing run, including failed runs; no forced paid retry. Hard limits reject oversized input without truncation.",
  })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 202, type: TopicAnalysisStatusDto })
  start(
    @Param() parameters: TopicAnalysisCampaignParametersDto,
    @CurrentUserId() userId: PrincipalDto,
  ): Promise<TopicAnalysisStatusDto> {
    return this.analyses.start(parameters.campaignId, String(userId));
  }

  @Get(":analysisId")
  @ApiOperation({
    operationId: "getFeedbackTopicAnalysis",
    description:
      "Durable run status. Observed usage/cost covers committed responses only; missing provider cost and crash windows can make it incomplete. This is a snapshot analysis, not a continuously refreshed campaign summary.",
  })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: TopicAnalysisStatusDto })
  get(
    @Param() parameters: TopicAnalysisParametersDto,
    @CurrentUserId() _userId: PrincipalDto,
  ): Promise<TopicAnalysisStatusDto> {
    return this.analyses.get(parameters.campaignId, parameters.analysisId);
  }

  @Get(":analysisId/result")
  @ApiOperation({
    operationId: "getFeedbackTopicAnalysisResult",
    description:
      "Returns immutable input/provenance and the complete persisted topic assignment. Returns 409 until completed; null topic IDs are outliers. Respondent counts count distinct respondents in code.",
  })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: TopicAnalysisResultDto })
  result(
    @Param() parameters: TopicAnalysisParametersDto,
    @CurrentUserId() _userId: PrincipalDto,
  ): Promise<TopicAnalysisResultDto> {
    return this.analyses.getResult(
      parameters.campaignId,
      parameters.analysisId,
    );
  }
}
