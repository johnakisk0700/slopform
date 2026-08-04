import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";

import { CurrentUserId } from "../../../infrastructure/auth/current-user-id.decorator.js";
import { PrincipalDto } from "../../../infrastructure/auth/auth.schemas.js";
import {
  FeedbackOutboxHistoryDto,
  FeedbackOutboxHistoryQueryDto,
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
 * Every operation is `GET`. Nothing here retries, cancels or re-enqueues
 * anything: the dispatcher and extractor are untouched by this controller,
 * which exists so an operator can inspect durable state without a hand-written
 * database query.
 */
@ApiTags("feedback-outbox")
@Controller("feedback/outbox")
export class PostEventFeedbackOutboxController {
  constructor(private readonly queueView: FeedbackOutboxQueueViewService) {}

  /**
   * The polled list. PostgreSQL and one batched MongoDB read only.
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

  /**
   * The history half: rows of any status with the decision log's origin, so
   * delivered messages stay reachable after the queue drains. Declared before
   * `:outboxId` on purpose — route order is match order.
   *
   * Paged by keyset cursor and narrowed by status and `created_at` range. The
   * table is append-only and never pruned, so «the newest 200» stopped being a
   * usable view of it during the first campaign; every parameter is optional
   * and the bare call still returns the newest page.
   */
  @Get("history")
  @ApiOperation({ operationId: "listFeedbackOutboxHistory" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: FeedbackOutboxHistoryDto })
  listHistory(
    @Query() query: FeedbackOutboxHistoryQueryDto,
    @CurrentUserId() _userId: PrincipalDto,
  ): Promise<FeedbackOutboxHistoryDto> {
    return this.queueView.listHistory(query);
  }

  /**
   * One opened row. Carries durable dispatcher facts and the decision log when
   * `message_outbox_log` has a row for it; the queue list never joins that
   * table, and the history list takes only its one-word origin.
   */
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
