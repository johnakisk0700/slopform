import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { feedbackPhoneE164ToChatJid } from "./feedback-simulator-phone.js";
import type {
  InjectFeedbackSimulatorMessageResponseDto,
  FeedbackSimulatorThreadResponseDto,
} from "./feedback-simulator.schemas.js";
import {
  PostEventFeedbackIngressService,
  type RecordObservedMessageResult,
} from "./post-event-feedback-ingress.service.js";
import { boundObservedMessageText } from "./post-event-feedback.schemas.js";
import { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";

@Injectable()
export class FeedbackSimulatorService {
  constructor(
    private readonly ingress: PostEventFeedbackIngressService,
    private readonly repository: PostEventFeedbackRepository,
  ) {}

  async injectObservedMessage(
    input: {
      readonly phoneE164: string;
      readonly text: string;
      readonly fromMe: boolean;
    },
    correlationId: string,
  ): Promise<InjectFeedbackSimulatorMessageResponseDto> {
    const observedAt = new Date();
    const providerMessageId = `sim-inject-${randomUUID()}`;
    const chatJid = feedbackPhoneE164ToChatJid(input.phoneE164);

    const result: RecordObservedMessageResult =
      await this.ingress.recordObservedMessage(
        {
          providerMessageId,
          chatJid,
          direction: input.fromMe ? "outbound" : "inbound",
          phoneE164: input.phoneE164,
          text: boundObservedMessageText(input.text),
          observedAt,
        },
        correlationId,
      );

    return {
      ingressId: result.ingressId,
      inserted: result.inserted,
    };
  }

  async getThreadByPhone(
    phoneE164: string,
  ): Promise<FeedbackSimulatorThreadResponseDto> {
    const [ingressRows, outboundRows] = await Promise.all([
      this.repository.listIngressByPhoneE164(phoneE164),
      this.repository.listSimOutboundByPhoneE164(phoneE164),
    ]);

    const messages = [
      ...ingressRows
        .filter((row) => row.text !== null)
        .map((row) => ({
          id: `ingress:${row.id}`,
          source: "ingress" as const,
          direction: row.direction as "inbound" | "outbound",
          text: row.text as string,
          occurredAt: row.observedAt.toISOString(),
          ingressId: row.id,
        })),
      ...outboundRows.map((row) => ({
        id: `sim-outbound:${row.id}`,
        source: "sim_outbound" as const,
        direction: "outbound" as const,
        text: row.body,
        occurredAt: row.sentAt.toISOString(),
        outboxId: row.outboxId,
      })),
    ].sort((left, right) => {
      const byTime = left.occurredAt.localeCompare(right.occurredAt);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });

    return { phoneE164, messages };
  }
}
