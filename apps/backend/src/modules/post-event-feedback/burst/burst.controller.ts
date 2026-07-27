import { ConflictException, Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";

import type { Environment } from "../../../infrastructure/config/environment.js";
import { BURST_PERSONAS } from "./burst-personas.js";
import {
  BURST_CAMPAIGNS,
  burstPersonaDisplayName,
  burstPersonaPhoneE164,
} from "./burst-scenario.js";
import {
  FeedbackBurstCatalogResponseDto,
  feedbackBurstCatalogResponseSchema,
} from "./burst.schemas.js";

/**
 * Dev-only catalogue for the multi-campaign burst rehearsal runner.
 *
 * The runner is plain Node and cannot import TypeScript, so it learns the
 * eighteen personas and three campaigns from this route — the same reason the
 * simulator exposes its own catalog.
 */
@ApiTags("dev-feedback-burst")
@Controller("dev/feedback/burst")
export class FeedbackBurstController {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  @Get("catalog")
  @ApiOperation({ operationId: "getFeedbackBurstCatalog" })
  @ZodResponse({ status: 200, type: FeedbackBurstCatalogResponseDto })
  getCatalog(): FeedbackBurstCatalogResponseDto {
    this.assertEnabled();
    return feedbackBurstCatalogResponseSchema.parse({
      campaigns: BURST_CAMPAIGNS.map((campaign) => ({
        slug: campaign.slug,
        ordinal: campaign.ordinal,
        title: campaign.title,
      })),
      personas: BURST_PERSONAS.map((persona) => ({
        id: persona.id,
        campaign: persona.campaign,
        ordinal: persona.ordinal,
        displayName: burstPersonaDisplayName(persona),
        phoneE164: burstPersonaPhoneE164(persona),
        quirk: persona.quirk,
        mirrors: persona.mirrors,
        messages: persona.messages.map((message) => ({
          afterMs: message.afterMs,
          text: message.text,
        })),
        expect: persona.expect,
      })),
    });
  }

  private assertEnabled(): void {
    if (
      this.config.get("NODE_ENV", { infer: true }) === "production" ||
      this.config.get("FEEDBACK_SIMULATOR_ENABLED", { infer: true }) !== true ||
      this.config.get("TRANSPORT_MODE", { infer: true }) !== "simulated"
    ) {
      throw new ConflictException(
        "The feedback burst catalogue requires non-production, FEEDBACK_SIMULATOR_ENABLED=true, and TRANSPORT_MODE=simulated.",
      );
    }
  }
}
