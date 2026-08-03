import { Injectable } from "@nestjs/common";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import {
  EventNotFoundError,
  EventsService,
} from "../../events/events.service.js";
import {
  ParticipantProfileNotFoundError,
  ParticipantsService,
} from "../../participants/participants.service.js";
import {
  FeedbackCampaignNotFoundError,
  PostEventFeedbackCampaignService,
} from "../../post-event-feedback/campaign/campaign.service.js";
import { PostEventFeedbackConversationService } from "../../post-event-feedback/inbox/conversation.service.js";
import { FeedbackConversationNotFoundError } from "../../post-event-feedback/post-event-feedback-conversation.repository.js";
import { PostEventFeedbackCampaignSummaryService } from "../../post-event-feedback/summary/summary.service.js";
import type { AssistantToolCall } from "../assistant.schemas.js";

/**
 * How many rows any one tool may hand back to the model.
 *
 * A tool result is prompt text the next step pays for twice — once to read and
 * once to carry into every later step of the same turn. The cap is therefore a
 * cost boundary, not a display preference, and a truncated result says so in
 * its own payload so the model can narrow the question instead of quietly
 * answering from a slice it believes is the whole set.
 */
const TOOL_RESULT_MAX_ROWS = 25;

/** One tool call, as an operator watching the turn should see it. */
export interface AssistantToolActivity {
  readonly toolCallId: string;
  readonly tool: string;
  readonly label: string;
  state: "running" | "done" | "failed";
  readonly input: AssistantToolCall["input"];
  output: AssistantToolCall["output"];
  readonly inputTruncated: boolean;
  outputTruncated: boolean;
}

/**
 * What each tool is called in front of an operator.
 *
 * Kept beside the registry so a new tool and its label are added in one edit,
 * and phrased as work in progress — «Reading the campaign summary», not
 * «get_campaign_summary». An unknown name falls back to a generic line rather
 * than leaking a function name into the UI, which is what happens the first
 * time somebody adds a tool and forgets this table.
 */
const TOOL_ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  current_datetime: "Checking the date",
  list_events: "Searching events",
  get_event: "Reading an event",
  search_participants: "Searching people",
  get_participant: "Reading a profile",
  list_feedback_campaigns: "Searching feedback campaigns",
  get_campaign_summary: "Reading the campaign summary",
  list_feedback_conversations: "Searching feedback conversations",
  get_feedback_conversation: "Reading a conversation",
};

export function assistantToolActivityLabel(tool: string): string {
  return TOOL_ACTIVITY_LABELS[tool] ?? "Looking something up";
}

/**
 * Every tool input schema here is deliberately flat: primitives, enums and
 * optional scalars only.
 *
 * Tool schemas travel to four models across two providers, and the narrowest
 * accepted subset — not the AI SDK's — is what a schema must satisfy. Unions,
 * records, tuples and nested objects are the shapes that fail first, and they
 * fail as a provider rejection mid-turn rather than at startup, so
 * `assistant-tools.spec.ts` walks this registry and rejects them at build time
 * instead. Descriptions are mandatory for the same reason a column name is: an
 * undescribed field gets guessed at.
 */
@Injectable()
export class AssistantToolsService {
  constructor(
    private readonly events: EventsService,
    private readonly participants: ParticipantsService,
    private readonly campaigns: PostEventFeedbackCampaignService,
    private readonly conversations: PostEventFeedbackConversationService,
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
  ) {}

  /**
   * The read-only tool set offered to a turn.
   *
   * One set for every provider. Nothing here branches on the model: the SDK
   * owns the wire translation, and a tool that behaved differently per provider
   * would make the same question answerable two ways.
   */
  toolSet(): ToolSet {
    return {
      current_datetime: tool({
        description:
          "The current date and time in the venue's timezone. Call this before answering anything about today, this week, upcoming or past events — the model's own sense of the date is not reliable.",
        inputSchema: z.object({}),
        execute: async () => {
          const now = new Date();
          return {
            iso: now.toISOString(),
            timezone: "Europe/Athens",
            local: now.toLocaleString("en-GB", {
              timeZone: "Europe/Athens",
              dateStyle: "full",
              timeStyle: "short",
            }),
          };
        },
      }),

      list_events: tool({
        description:
          "List events with their date, status, venue and attendance counts. Use this to find an event before asking for its detail.",
        inputSchema: z.object({
          status: z
            .enum(["draft", "scheduled", "finished", "cancelled"])
            .optional()
            .describe("Keep only events in this status."),
          search: z
            .string()
            .optional()
            .describe(
              "Case-insensitive match against the event title and venue label.",
            ),
        }),
        execute: async ({ status, search }) => {
          const { items } = await this.events.list();
          const needle = search?.trim().toLowerCase();
          const matched = items.filter((event) => {
            if (status && event.status !== status) return false;
            if (!needle) return true;
            return (
              event.title.toLowerCase().includes(needle) ||
              (event.venue?.label?.toLowerCase().includes(needle) ?? false)
            );
          });

          return capRows(
            matched.map((event) => ({
              eventId: event.id,
              title: event.title,
              startsAt: event.startsAt,
              status: event.status,
              venue: event.venue?.label ?? null,
              area: event.venue?.area ?? null,
              attendeeCount: event.attendeeCount,
              presentCount: event.presentCount,
            })),
          );
        },
      }),

      get_event: tool({
        description:
          "One event in full, including its attendee roster and whether a feedback campaign already exists for it.",
        inputSchema: z.object({
          eventId: z
            .uuid()
            .describe("The event id, as returned by list_events."),
        }),
        execute: async ({ eventId }) => {
          try {
            const event = await this.events.get(eventId);
            const roster = capRows(
              event.attendees.map((attendee) => ({
                participantId: attendee.participantId,
                preferredName: attendee.preferredName,
                email: attendee.emailNormalized,
                tableNo: attendee.tableNo,
                present: attendee.present,
              })),
            );

            return {
              eventId: event.id,
              title: event.title,
              startsAt: event.startsAt,
              status: event.status,
              venue: event.venue?.label ?? null,
              venueType: event.venue?.type ?? null,
              venueArea: event.venue?.area ?? null,
              venuePriceLevel: event.venue?.priceLevel ?? null,
              attendeeCount: event.attendeeCount,
              presentCount: event.presentCount,
              feedbackCampaignId: event.feedbackCampaignId,
              attendees: roster.rows,
              attendeesTruncated: roster.truncated,
            };
          } catch (error) {
            if (error instanceof EventNotFoundError) {
              return notFound("event", eventId);
            }
            throw error;
          }
        },
      }),

      search_participants: tool({
        description:
          "Find people by name, email or phone number. Returns their contact details and feedback opt-in state.",
        inputSchema: z.object({
          query: z
            .string()
            .optional()
            .describe(
              "Case-insensitive fragment of a preferred name, email address or phone number. Omit to list everyone.",
            ),
          feedbackOptInOnly: z
            .boolean()
            .optional()
            .describe(
              "Keep only people who opted in to post-event feedback over WhatsApp.",
            ),
        }),
        execute: async ({ query, feedbackOptInOnly }) => {
          const { items } = await this.participants.list();
          const needle = query?.trim().toLowerCase();
          const matched = items.filter((participant) => {
            if (
              feedbackOptInOnly &&
              !participant.postEventFeedbackWhatsappOptIn
            ) {
              return false;
            }
            if (!needle) return true;
            return (
              (participant.preferredName?.toLowerCase().includes(needle) ??
                false) ||
              participant.emailNormalized.toLowerCase().includes(needle) ||
              (participant.phoneE164?.toLowerCase().includes(needle) ?? false)
            );
          });

          return capRows(
            matched.map((participant) => ({
              participantId: participant.id,
              preferredName: participant.preferredName,
              email: participant.emailNormalized,
              phone: participant.phoneE164,
              neighborhood: participant.preferredNeighborhood,
              ageBand: participant.ageBand,
              feedbackOptIn: participant.postEventFeedbackWhatsappOptIn,
            })),
          );
        },
      }),

      get_participant: tool({
        description:
          "One person's full profile together with every event they were booked on.",
        inputSchema: z.object({
          participantId: z
            .uuid()
            .describe(
              "The participant id, as returned by search_participants.",
            ),
        }),
        execute: async ({ participantId }) => {
          try {
            const [participant, history] = await Promise.all([
              this.participants.get(participantId),
              this.participants.listEvents(participantId),
            ]);
            const events = capRows(
              history.items.map((item) => ({
                eventId: item.eventId,
                title: item.title,
                startsAt: item.startsAt,
                status: item.status,
                present: item.present,
                tableNo: item.tableNo,
              })),
            );

            return {
              participantId: participant.id,
              preferredName: participant.preferredName,
              email: participant.emailNormalized,
              phone: participant.phoneE164,
              neighborhood: participant.preferredNeighborhood,
              ageBand: participant.ageBand,
              conversationStyle: participant.conversationStyle,
              feedbackOptIn: participant.postEventFeedbackWhatsappOptIn,
              events: events.rows,
              eventsTruncated: events.truncated,
            };
          } catch (error) {
            if (error instanceof ParticipantProfileNotFoundError) {
              return notFound("participant", participantId);
            }
            throw error;
          }
        },
      }),

      list_feedback_campaigns: tool({
        description:
          "List post-event feedback campaigns with their event, status and how many conversations are open, need a person, or are stuck waiting on the model.",
        inputSchema: z.object({
          status: z
            .enum(["launched", "paused", "closed"])
            .optional()
            .describe("Keep only campaigns in this status."),
          needsAttentionOnly: z
            .boolean()
            .optional()
            .describe(
              "Keep only campaigns with at least one conversation waiting for a person.",
            ),
        }),
        execute: async ({ status, needsAttentionOnly }) => {
          const { items } = await this.campaigns.list();
          const matched = items.filter((campaign) => {
            if (status && campaign.status !== status) return false;
            if (needsAttentionOnly && campaign.needsAttentionCount === 0) {
              return false;
            }
            return true;
          });

          return capRows(
            matched.map((campaign) => ({
              campaignId: campaign.id,
              eventId: campaign.eventId,
              eventTitle: campaign.eventTitle,
              status: campaign.status,
              launchedAt: campaign.launchedAt,
              conversationCount: campaign.conversationCount,
              openCount: campaign.openCount,
              needsAttentionCount: campaign.needsAttentionCount,
              extractionParkedCount: campaign.extractionParkedCount,
            })),
          );
        },
      }),

      get_campaign_summary: tool({
        description:
          "The AI-written summary of one campaign's feedback, with the counts it was written from. Returns its status — a summary may be pending, partial or absent, and an absent one is not an empty one.",
        inputSchema: z.object({
          campaignId: z
            .uuid()
            .describe(
              "The campaign id, as returned by list_feedback_campaigns.",
            ),
        }),
        execute: async ({ campaignId }) => {
          try {
            const summary = await this.summaries.get(campaignId);
            return {
              campaignId,
              status: summary.status,
              body: summary.body,
              /**
               * A partial summary was written while conversations were still
               * open. Handing the model the flag rather than hiding it is what
               * lets it say «so far» instead of stating a closed finding.
               */
              isPartial: summary.isPartial,
              answerCount: summary.answerCount,
              noteCount: summary.noteCount,
              openConversationCount: summary.openConversationCount,
              generatedAt: summary.generatedAt,
            };
          } catch (error) {
            if (error instanceof FeedbackCampaignNotFoundError) {
              return notFound("campaign", campaignId);
            }
            throw error;
          }
        },
      }),

      list_feedback_conversations: tool({
        description:
          "The conversations of one campaign: who was asked, whether the bot or a person is answering, how far the questions got, and which ones want a human.",
        inputSchema: z.object({
          campaignId: z
            .uuid()
            .describe(
              "The campaign id, as returned by list_feedback_campaigns.",
            ),
          state: z
            .enum(["open", "closed"])
            .optional()
            .describe("Keep only conversations in this lifecycle state."),
          needsAttentionOnly: z
            .boolean()
            .optional()
            .describe("Keep only conversations flagged for a person."),
        }),
        execute: async ({ campaignId, state, needsAttentionOnly }) => {
          try {
            const view = await this.conversations.listForCampaign(campaignId);
            const matched = view.conversations.filter((conversation) => {
              if (state && conversation.lifecycle.state !== state) return false;
              if (needsAttentionOnly && !conversation.needsAttention) {
                return false;
              }
              return true;
            });

            const rows = capRows(
              matched.map((conversation) => ({
                conversationId: conversation.id,
                respondent: conversation.respondentDisplayName,
                participantId: conversation.respondentParticipantId,
                phone: conversation.phoneAtLaunch,
                state: conversation.lifecycle.state,
                closeReason: conversation.lifecycle.reason,
                control: conversation.control.mode,
                answered: conversation.goals.filter(
                  (goal) => goal.status === "answered",
                ).length,
                goalCount: conversation.goals.length,
                messageCount: conversation.messageCount,
                lastMessageAt: conversation.lastMessageAt,
                needsAttention: conversation.needsAttention,
              })),
            );

            return {
              campaignId,
              eventTitle: view.campaign.eventTitle,
              campaignStatus: view.campaign.status,
              openCount: view.campaign.openCount,
              needsAttentionCount: view.campaign.needsAttentionCount,
              ...rows,
            };
          } catch (error) {
            if (error instanceof FeedbackCampaignNotFoundError) {
              return notFound("campaign", campaignId);
            }
            throw error;
          }
        },
      }),

      get_feedback_conversation: tool({
        description:
          "One conversation in full: the WhatsApp transcript, the extracted answers, the staff notes and why it was flagged for a person. Use this to answer what somebody actually said.",
        inputSchema: z.object({
          campaignId: z.uuid().describe("The campaign the conversation is in."),
          conversationId: z
            .uuid()
            .describe(
              "The conversation id, as returned by list_feedback_conversations.",
            ),
        }),
        execute: async ({ campaignId, conversationId }) => {
          try {
            const [detail, results] = await Promise.all([
              this.conversations.get(campaignId, conversationId),
              this.conversations.listConversationResults(
                campaignId,
                conversationId,
              ),
            ]);

            /**
             * The tail, not the head.
             *
             * A long conversation clipped from the front hands the model the
             * greeting and drops the disclosure; what an operator asks about is
             * almost always what was said most recently.
             */
            const transcript = detail.messages.slice(-TOOL_RESULT_MAX_ROWS);

            return {
              conversationId: detail.id,
              campaignId: detail.campaignId,
              respondent: detail.respondentDisplayName,
              participantId: detail.respondentParticipantId,
              phone: detail.phoneAtLaunch,
              state: detail.lifecycle.state,
              closeReason: detail.lifecycle.reason,
              control: detail.control.mode,
              needsAttention: detail.needsAttention,
              // Unresolved only. A reason a person already dealt with is
              // history, and handing it over unlabelled would have the model
              // report a settled flag as a live one.
              attentionReasons: detail.attentionReasons
                .filter((reason) => reason.resolvedAt === null)
                .map((reason) => reason.kind),
              goals: detail.goals.map((goal) => ({
                key: goal.key,
                prompt: goal.prompt,
                status: goal.status,
              })),
              messages: transcript.map((message) => ({
                actor: message.actor,
                text: message.text,
                at: message.at,
              })),
              messagesTruncated: detail.messages.length > transcript.length,
              messageCount: detail.messages.length,
              answers: results.answers.map((answer) => ({
                question: answer.questionKey,
                rating: answer.valueInt,
                about: answer.subjectDisplayName,
                origin: answer.origin,
              })),
              notes: results.notes.map((note) => ({
                type: note.noteType,
                text: note.text,
                status: note.status,
                about: note.subjectDisplayName,
                origin: note.origin,
              })),
            };
          } catch (error) {
            if (error instanceof FeedbackCampaignNotFoundError) {
              return notFound("campaign", campaignId);
            }
            if (error instanceof FeedbackConversationNotFoundError) {
              return notFound("conversation", conversationId);
            }
            throw error;
          }
        },
      }),
    };
  }
}

/**
 * A missing row is an answer, not a failure.
 *
 * Throwing would end the turn on a question the operator can still be helped
 * with — a mistyped id deserves «that one does not exist», not a provider
 * error. The model receives the same shape it would for a hit, so it can say so
 * plainly rather than inventing a record to fill the gap.
 */
function notFound(
  entity: string,
  id: string,
): {
  readonly found: false;
  readonly entity: string;
  readonly id: string;
} {
  return { found: false, entity, id };
}

function capRows<Row>(rows: readonly Row[]): {
  readonly rows: readonly Row[];
  readonly total: number;
  readonly truncated: boolean;
} {
  return {
    rows: rows.slice(0, TOOL_RESULT_MAX_ROWS),
    total: rows.length,
    truncated: rows.length > TOOL_RESULT_MAX_ROWS,
  };
}
