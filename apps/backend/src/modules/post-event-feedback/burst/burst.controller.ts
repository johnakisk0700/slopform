import { InjectQueue } from "@nestjs/bullmq";
import { ConflictException, Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { Queue } from "bullmq";

import type { Environment } from "../../../infrastructure/config/environment.js";
import { isFeedbackSimulatorEnabled } from "../../../infrastructure/config/enabled-modules.js";
import { FEEDBACK_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import { BURST_PERSONAS } from "./burst-personas.js";
import {
  BURST_CAMPAIGNS,
  burstPersonaCatalogEntry,
  burstPersonaPhoneE164,
} from "./burst-scenario.js";
import {
  FeedbackBurstCatalogResponseDto,
  feedbackBurstCatalogResponseSchema,
} from "./burst.schemas.js";
import {
  attestFeedbackWorkers,
  resolveFeedbackWorkerControlProfile,
} from "../worker-attestation.js";

/**
 * Clerk-protected catalogue for the multi-campaign burst rehearsal runner.
 *
 * The runner is plain Node and cannot import TypeScript, so it learns the
 * campaigns and personas from this route — the same reason the simulator
 * exposes its own catalog. Counts are never restated here: the runner reports
 * what this endpoint serves, which is how a stale `dist` becomes visible in the
 * log instead of quietly measuring code nobody is running. It also reports
 * whether this process has
 * the extraction stub on and whether a feedback worker is registered, so the
 * runner can refuse a free rehearsal that would otherwise bill a provider.
 */
@ApiTags("dev-feedback-burst")
@Controller("dev/feedback/burst")
export class FeedbackBurstController {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    @InjectQueue(FEEDBACK_QUEUE) private readonly queue: Queue,
  ) {}

  @Get("catalog")
  @ApiOperation({ operationId: "getFeedbackBurstCatalog" })
  @ZodResponse({ status: 200, type: FeedbackBurstCatalogResponseDto })
  async getCatalog(): Promise<FeedbackBurstCatalogResponseDto> {
    this.assertEnabled();
    const workers = await this.queue.getWorkers();
    const extractionStub = this.config.get("FEEDBACK_EXTRACTION_STUB", {
      infer: true,
    });
    const workerAttestation = attestFeedbackWorkers(
      workers,
      resolveFeedbackWorkerControlProfile({
        extractionStub,
        model: this.config.get("FEEDBACK_EXTRACTION_MODEL", { infer: true }),
        extractionReasoningEffort: this.config.get(
          "FEEDBACK_EXTRACTION_REASONING_EFFORT",
          { infer: true },
        ),
        attentionReasoningEffort: this.config.get(
          "FEEDBACK_ATTENTION_REASONING_EFFORT",
          { infer: true },
        ),
        serviceTier: this.config.get("FEEDBACK_EXTRACTION_SERVICE_TIER", {
          infer: true,
        }),
      }),
    );
    return feedbackBurstCatalogResponseSchema.parse({
      extractionStub,
      workerRegistered: workerAttestation.status === "verified",
      campaigns: BURST_CAMPAIGNS.map((campaign) => ({
        slug: campaign.slug,
        ordinal: campaign.ordinal,
        title: campaign.title,
        venue: campaign.venue,
      })),
      personas: BURST_PERSONAS.map(burstPersonaCatalogEntry),
    });
  }

  private assertEnabled(): void {
    if (
      !isFeedbackSimulatorEnabled({
        nodeEnv: this.config.get("NODE_ENV", { infer: true }),
        productionRehearsalEnabled: this.config.get(
          "FEEDBACK_PRODUCTION_REHEARSAL_ENABLED",
          { infer: true },
        ),
        simulatorEnabled: this.config.get("FEEDBACK_SIMULATOR_ENABLED", {
          infer: true,
        }),
        transportMode: this.config.get("TRANSPORT_MODE", { infer: true }),
      })
    ) {
      throw new ConflictException(
        "The feedback burst catalogue requires FEEDBACK_SIMULATOR_ENABLED=true and TRANSPORT_MODE=simulated; production additionally requires FEEDBACK_PRODUCTION_REHEARSAL_ENABLED=true.",
      );
    }
  }
}
