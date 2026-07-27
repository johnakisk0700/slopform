import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";

import { CurrentUserId } from "../../../infrastructure/auth/current-user-id.decorator.js";
import { PrincipalDto } from "../../../infrastructure/auth/auth.schemas.js";
import {
  FeedbackOutboxIdParamDto,
  FeedbackOutboxMessageDeliveryDto,
  FeedbackOutboxQueueDto,
} from "./queue-view.schemas.js";
import {
  FeedbackOutboxMessageNotFoundError,
  FeedbackOutboxQueueViewService,
} from "./queue-view.service.js";

/**
 * Read-only observability for outbound feedback messages.
 *
 * Both operations are `GET`. Nothing here retries, cancels or re-enqueues
 * anything: the queue, the relay, the delivery service and the extractor are
 * untouched by this controller, which exists so an operator can see what they
 * are doing without a hand-written Redis script.
 */
@ApiTags("feedback-outbox")
@Controller("feedback/outbox")
export class PostEventFeedbackOutboxController {
  constructor(private readonly queueView: FeedbackOutboxQueueViewService) {}

  /**
   * The polled list. PostgreSQL and one batched MongoDB read only — a Redis
   * lookup per row on a five-second poll is a load amplifier, so queue state
   * belongs to `getFeedbackOutboxMessage` and the row an operator opened.
   */
  @Get("queue")
  @ApiOperation({ operationId: "listFeedbackOutboxQueue" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackOutboxQueueDto })
  listQueue(
    @CurrentUserId() _userId: PrincipalDto,
  ): Promise<FeedbackOutboxQueueDto> {
    return this.queueView.listQueue();
  }

  @Get(":outboxId")
  @ApiOperation({ operationId: "getFeedbackOutboxMessage" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackOutboxMessageDeliveryDto })
  async getMessage(
    @Param() parameters: FeedbackOutboxIdParamDto,
    @CurrentUserId() _userId: PrincipalDto,
  ): Promise<FeedbackOutboxMessageDeliveryDto> {
    try {
      return await this.queueView.getMessageDelivery(parameters.outboxId);
    } catch (error) {
      if (error instanceof FeedbackOutboxMessageNotFoundError) {
        throw new NotFoundException(error.message, { cause: error });
      }
      throw error;
    }
  }
}
