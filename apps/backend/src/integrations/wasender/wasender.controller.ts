import {
  Body,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodResponse } from "nestjs-zod";

import { Public } from "../../infrastructure/auth/public.decorator.js";
import { MessageOutboxDeliveryStatusService } from "../../modules/post-event-feedback/outbox/delivery-status.service.js";
import {
  PostEventFeedbackEnqueueError,
  PostEventFeedbackIngressService,
} from "../../modules/post-event-feedback/ingress/ingress.service.js";
import { boundObservedMessageText } from "../../modules/post-event-feedback/jobs.schemas.js";
import {
  WasenderCorrelationIdDto,
  WasenderWebhookAcknowledgementDto,
  WasenderWebhookDto,
} from "./wasender.schemas.js";
import {
  WasenderWebhookParser,
  WasenderWebhookSignatureVerifier,
} from "./wasender.webhook.js";

type RequestWithId = Request & { id: string };
const RequestCorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<RequestWithId>().id,
);

@ApiTags("webhooks")
@Public()
@Controller("webhooks/wasender")
export class WasenderWebhookController {
  private readonly logger = new Logger(WasenderWebhookController.name);

  constructor(
    private readonly verifier: WasenderWebhookSignatureVerifier,
    private readonly parser: WasenderWebhookParser,
    private readonly ingress: PostEventFeedbackIngressService,
    private readonly deliveryStatus: MessageOutboxDeliveryStatusService,
  ) {}

  /**
   * The provider-facing edge (D8): authenticate, normalize, then perform one
   * durable ingress write and one materialize enqueue per observed personal
   * message. Status updates patch delivery columns on the correlated outbox
   * row. Matching, transcripts and STOP belong to the worker.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiUnauthorizedResponse({ description: "Invalid webhook signature" })
  @ZodResponse({ status: 200, type: WasenderWebhookAcknowledgementDto })
  async receive(
    @Headers("x-webhook-signature") signature: string | undefined,
    @Body() body: WasenderWebhookDto,
    @RequestCorrelationId() requestId: WasenderCorrelationIdDto,
  ): Promise<WasenderWebhookAcknowledgementDto> {
    if (!this.verifier.verify(signature)) {
      throw new UnauthorizedException("Invalid webhook signature");
    }

    const correlationId = String(requestId);
    const events = this.parser.parse(body);
    let recordedCount = 0;
    let skippedCount = 0;
    let deferredCount = 0;

    for (const event of events) {
      if (event.type !== "message.observed") {
        await this.deliveryStatus.applyStatusChange(
          {
            providerMessageId: event.providerMessageId,
            status: event.status,
            occurredAt: new Date(event.occurredAt),
          },
          correlationId,
        );
        // Counted for acknowledgement parity; unmatched status events are a
        // no-op when no outbox row has that provider message id yet.
        deferredCount += 1;
        continue;
      }

      // Feedback conversations are one-to-one chats. Group, newsletter and
      // unrecognized chat kinds are never stored, which keeps unrelated
      // shared-session traffic out of the durable ingress table entirely.
      if (event.chatKind !== "personal") {
        skippedCount += 1;
        this.logger.log({
          event: "wasender.webhook.chat_kind_skipped",
          correlationId,
          chatKind: event.chatKind,
        });
        continue;
      }

      try {
        await this.ingress.recordObservedMessage(
          {
            providerMessageId: event.providerMessageId,
            chatJid: event.chatJid,
            direction: event.direction,
            phoneE164: event.counterpartyPhoneE164,
            text: boundObservedMessageText(event.text),
            observedAt: new Date(event.occurredAt),
          },
          correlationId,
        );
        recordedCount += 1;
      } catch (error) {
        if (error instanceof PostEventFeedbackEnqueueError) {
          // The row is committed but unqueued. Refusing the acknowledgement
          // invites a provider redelivery instead of hiding a stalled message.
          throw new ServiceUnavailableException(
            "The observed message could not be queued",
          );
        }
        throw error;
      }
    }

    return {
      received: true,
      eventCount: events.length,
      recordedCount,
      skippedCount,
      deferredCount,
    };
  }
}
