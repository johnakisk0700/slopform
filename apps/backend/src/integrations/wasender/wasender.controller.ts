import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";

import { Public } from "../../infrastructure/auth/public.decorator.js";
import {
  WasenderWebhookAcknowledgementDto,
  WasenderWebhookDto,
} from "./wasender.schemas.js";
import {
  WasenderWebhookParser,
  WasenderWebhookSignatureVerifier,
} from "./wasender.webhook.js";

@ApiTags("webhooks")
@Public()
@Controller("webhooks/wasender")
export class WasenderWebhookController {
  constructor(
    private readonly verifier: WasenderWebhookSignatureVerifier,
    private readonly parser: WasenderWebhookParser,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiUnauthorizedResponse({ description: "Invalid webhook signature" })
  @ZodResponse({ status: 200, type: WasenderWebhookAcknowledgementDto })
  receive(
    @Headers("x-webhook-signature") signature: string | undefined,
    @Body() body: WasenderWebhookDto,
  ): WasenderWebhookAcknowledgementDto {
    if (!this.verifier.verify(signature)) {
      throw new UnauthorizedException("Invalid webhook signature");
    }

    // This normalized, provider-bounded event list is the handoff seam for the
    // durable message domain. The endpoint stays disabled until that consumer
    // exists; see the integration mechanism documentation.
    const eventCount = this.parser.parse(body).length;
    return { received: true, eventCount };
  }
}
