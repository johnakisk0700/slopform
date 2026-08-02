import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { ConfigService } from "@nestjs/config";

import type { Environment } from "../../../infrastructure/config/environment.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { EventsRepository } from "../../events/events.repository.js";
import type { EventsService } from "../../events/events.service.js";
import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import type { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  FeedbackSimulatorRunRejectedError,
  FeedbackSimulatorService,
  isFeedbackSimulatorSingleTurnScenario,
  renderFeedbackSimulatorTemplate,
} from "./simulator.service.js";
import { startFeedbackSimulatorRunSchema } from "./simulator.schemas.js";
import { runStage } from "./run-status.js";
import type { PostEventFeedbackIngressService } from "../ingress/ingress.service.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackResultsRepository } from "../extraction/results.repository.js";
import type { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import type { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import type { FeedbackSimOutboundRepository } from "./sim-outbound.repository.js";
import type { FeedbackJobData, FeedbackJobName } from "../jobs.schemas.js";
import {
  createFeedbackWorkerRegistrationName,
  resolveFeedbackWorkerControlProfile,
} from "../worker-attestation.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const respondentId = "44444444-4444-4444-8444-444444444444";
const candidateId = "55555555-5555-4555-8555-555555555555";
const introOutboxId = "66666666-6666-4666-8666-666666666666";
const ingressId = "77777777-7777-4777-8777-777777777777";
const correlationId = "feedback-eval-test-1";
const enabledFeedbackVenue = {
  contextRevision: 7,
  venue: {
    label: "Ρακί Μεζέ",
    type: "μεζεδοπωλείο",
    area: "Παγκράτι",
    priceRange: {
      startMinor: 1_800,
      endMinor: 2_500,
      currencyCode: "EUR",
    },
  },
} as const;

describe("real-model feedback simulator", () => {
  it("requires explicit paid-run confirmation at the HTTP boundary", () => {
    const selection = {
      campaignId,
      conversationId,
      scenarioId: "greeklish",
      expectedModel: "openai/gpt-5.6-luna",
    };

    expect(startFeedbackSimulatorRunSchema.safeParse(selection).success).toBe(
      false,
    );
    expect(
      startFeedbackSimulatorRunSchema.safeParse({
        ...selection,
        confirmPaidRun: true,
      }).success,
    ).toBe(true);
  });

  it("rejects an unconfirmed service call before any write", async () => {
    const harness = createHarness();

    await expect(
      harness.service.startScenarioRun(
        {
          campaignId,
          conversationId,
          scenarioId: "greeklish",
          expectedModel: "openai/gpt-5.6-luna",
          confirmPaidRun: false,
        } as never,
        correlationId,
      ),
    ).rejects.toThrow("Explicit paid-run confirmation is required");
    expect(harness.outboundTranscript.record).not.toHaveBeenCalled();
    expect(harness.ingress.recordObservedMessage).not.toHaveBeenCalled();
  });

  it("rejects provider-default extraction reasoning before worker lookup or writes", async () => {
    const harness = createHarness({
      FEEDBACK_EXTRACTION_REASONING_EFFORT: "",
    });

    await expect(
      harness.service.startScenarioRun(
        {
          campaignId,
          conversationId,
          scenarioId: "greeklish",
          expectedModel: "openai/gpt-5.6-luna",
          confirmPaidRun: true,
        },
        correlationId,
      ),
    ).rejects.toThrow(
      "requires an explicit FEEDBACK_EXTRACTION_REASONING_EFFORT",
    );
    expect(harness.queue.getWorkers).not.toHaveBeenCalled();
    expect(harness.outboundTranscript.record).not.toHaveBeenCalled();
    expect(harness.ingress.recordObservedMessage).not.toHaveBeenCalled();
  });

  it("exposes only the two agreed models and clean single-window scenarios", async () => {
    const { service } = createHarness();
    const catalog = await service.getCatalog();

    expect(catalog.availableModels).toEqual([
      "openai/gpt-5.6-luna",
      "qwen/qwen3.7-max",
    ]);
    expect(catalog).toMatchObject({
      activeModel: "openai/gpt-5.6-luna",
      activeExtractionReasoningEffort: "xhigh",
      activeAttentionReasoningEffort: "none",
      activeServiceTier: null,
      workerAttestation: {
        status: "verified",
        registeredWorkerCount: 1,
      },
    });
    expect(catalog.timingPolicy).toBe("single_quiet_window_batch");
    expect(catalog.scenarios).toHaveLength(23);
    const scoreFollowUpIntents = [
      "ask_event_score",
      "ask_table_fit",
      "ask_participation_ease",
      "ask_conversation_balance",
    ] as const;
    expect(
      [
        ...new Set(
          catalog.scenarios
            .map((scenario) => scenario.rubric.reply?.requiredIntent)
            .filter((intent): intent is (typeof scoreFollowUpIntents)[number] =>
              scoreFollowUpIntents.some((candidate) => candidate === intent),
            ),
        ),
      ].sort(),
    ).toEqual([...scoreFollowUpIntents].sort());
    expect(catalog.scenarios.map((scenario) => scenario.id)).not.toEqual(
      expect.arrayContaining([
        "slow_typist",
        "changes_the_score",
        "number_changed_owner",
        "refuses_a_question",
        "discloses_as_the_very_last_thing",
      ]),
    );
  });

  it("publishes the resolved paid-model controls used by the runner", async () => {
    const { service } = createHarness({
      FEEDBACK_EXTRACTION_REASONING_EFFORT: "high",
      FEEDBACK_ATTENTION_REASONING_EFFORT: "low",
      FEEDBACK_EXTRACTION_SERVICE_TIER: "priority",
    });

    await expect(service.getCatalog()).resolves.toMatchObject({
      activeModel: "openai/gpt-5.6-luna",
      activeExtractionReasoningEffort: "high",
      activeAttentionReasoningEffort: "low",
      activeServiceTier: "priority",
    });
  });

  it("reports no effective OpenAI service tier for an OpenRouter model", async () => {
    const { service } = createHarness({
      FEEDBACK_EXTRACTION_MODEL: "qwen/qwen3.7-max",
      FEEDBACK_EXTRACTION_REASONING_EFFORT: "high",
      FEEDBACK_EXTRACTION_SERVICE_TIER: "priority",
    });

    await expect(service.getCatalog()).resolves.toMatchObject({
      activeModel: "qwen/qwen3.7-max",
      activeExtractionReasoningEffort: "high",
      activeAttentionReasoningEffort: "none",
      activeServiceTier: null,
    });
  });

  it("uses cumulative leading-edge time instead of per-message gaps", () => {
    expect(
      isFeedbackSimulatorSingleTurnScenario({
        messages: [
          { afterMs: 0, textTemplate: "one" },
          { afterMs: 25_000, textTemplate: "two" },
          { afterMs: 25_000, textTemplate: "three" },
        ],
      }),
    ).toBe(false);
    expect(
      isFeedbackSimulatorSingleTurnScenario({
        messages: [
          { afterMs: 0, textTemplate: "one" },
          { afterMs: 20_000, textTemplate: "two" },
          { afterMs: 20_000, textTemplate: "three" },
        ],
      }),
    ).toBe(true);
  });

  it("renders live candidate names and rejects unresolved slots", () => {
    expect(
      renderFeedbackSimulatorTemplate("hello {candidate1}", [
        { slot: "candidate1", displayName: "Ada" },
      ]),
    ).toBe("hello Ada");
    expect(() =>
      renderFeedbackSimulatorTemplate("hello {candidate2}", [
        { slot: "candidate1", displayName: "Ada" },
      ]),
    ).toThrow("unresolved candidate slot: candidate2");
  });

  it("preflights exact live bindings without writes, then repairs the intro only on a confirmed run", async () => {
    const harness = createHarness();

    const preview = await harness.service.preflightScenarioRun(
      {
        campaignId,
        conversationId,
        scenarioId: "greeklish",
        expectedModel: "openai/gpt-5.6-luna",
      },
      correlationId,
    );

    expect(preview).toMatchObject({
      correlationId,
      eventId,
      campaignId,
      conversationId,
      respondentParticipantId: respondentId,
      workerRegistered: true,
      workerAttestation: {
        status: "verified",
        observedProfiles: [
          {
            model: "openai/gpt-5.6-luna",
            provider: "openai",
            providerModelId: "gpt-5.6-luna",
          },
        ],
      },
      baseline: {
        clean: true,
        currentMessageCount: 0,
        effectiveMessageCount: 1,
        introTranscriptRepairRequired: true,
      },
      feedbackVenue: enabledFeedbackVenue,
      candidateBindings: [
        {
          slot: "candidate1",
          participantId: candidateId,
          displayName: "Ada",
        },
      ],
    });
    expect(JSON.stringify(preview.feedbackVenue)).not.toMatch(
      /"(?:provider|placeId|rating|reviews?)":/u,
    );
    expect(preview.renderedMessages[0]).toContain("Ada");
    expect(harness.outboundTranscript.record).not.toHaveBeenCalled();
    expect(harness.ingress.recordObservedMessage).not.toHaveBeenCalled();

    const run = await harness.service.startScenarioRun(
      {
        campaignId,
        conversationId,
        scenarioId: "greeklish",
        expectedModel: "openai/gpt-5.6-luna",
        confirmPaidRun: true,
      },
      correlationId,
    );

    expect(harness.outboundTranscript.record).toHaveBeenCalledOnce();
    expect(harness.ingress.recordObservedMessage).toHaveBeenCalledOnce();
    expect(run).toMatchObject({
      correlationId,
      campaignId,
      conversationId,
      scenarioId: "greeklish",
      stage: "materializing",
      progress: { targetCursorSeq: 2 },
    });
  });

  it.each([
    ["absent", { contextRevision: 0, venue: null }],
    ["disabled", { contextRevision: 4, venue: null }],
  ] as const)(
    "refuses an event whose feedback venue is %s before any write",
    async (_state, feedbackVenue) => {
      const harness = createHarness({}, 2, feedbackVenue);

      await expect(
        harness.service.startScenarioRun(
          {
            campaignId,
            conversationId,
            scenarioId: "greeklish",
            expectedModel: "openai/gpt-5.6-luna",
            confirmPaidRun: true,
          },
          correlationId,
        ),
      ).rejects.toThrow(
        "requires a configured event venue with useInFeedback enabled",
      );
      expect(harness.outboundTranscript.record).not.toHaveBeenCalled();
      expect(harness.ingress.recordObservedMessage).not.toHaveBeenCalled();
    },
  );

  it("reports a stopped worker read-only but hard-blocks confirmed start before writes", async () => {
    const harness = createHarness();
    harness.queue.getWorkers.mockResolvedValue([]);

    const preview = await harness.service.preflightScenarioRun(
      {
        campaignId,
        conversationId,
        scenarioId: "greeklish",
        expectedModel: "openai/gpt-5.6-luna",
      },
      correlationId,
    );

    expect(preview.workerRegistered).toBe(false);
    expect(preview.workerAttestation.status).toBe("absent");
    expect(preview.warning).toMatch(/no feedback worker/iu);
    await expect(
      harness.service.startScenarioRun(
        {
          campaignId,
          conversationId,
          scenarioId: "greeklish",
          expectedModel: "openai/gpt-5.6-luna",
          confirmPaidRun: true,
        },
        correlationId,
      ),
    ).rejects.toThrow("No feedback worker is registered");
    expect(harness.outboundTranscript.record).not.toHaveBeenCalled();
    expect(harness.ingress.recordObservedMessage).not.toHaveBeenCalled();
  });

  it("hard-blocks a valid but differently configured worker before writes", async () => {
    const harness = createHarness();
    const staleProfile = resolveFeedbackWorkerControlProfile({
      extractionStub: true,
      model: "openai/gpt-5.6-luna",
      extractionReasoningEffort: undefined,
      attentionReasoningEffort: undefined,
      serviceTier: undefined,
    });
    harness.queue.getWorkers.mockResolvedValue([
      workerInfo(createFeedbackWorkerRegistrationName(staleProfile)),
    ]);

    const preview = await harness.service.preflightScenarioRun(
      {
        campaignId,
        conversationId,
        scenarioId: "greeklish",
        expectedModel: "openai/gpt-5.6-luna",
      },
      correlationId,
    );

    expect(preview).toMatchObject({
      workerRegistered: false,
      workerAttestation: {
        status: "mismatch",
        observedProfiles: [{ extractionStub: true }],
      },
    });
    await expect(
      harness.service.startScenarioRun(
        {
          campaignId,
          conversationId,
          scenarioId: "greeklish",
          expectedModel: "openai/gpt-5.6-luna",
          confirmPaidRun: true,
        },
        correlationId,
      ),
    ).rejects.toThrow("control profile disagrees");
    expect(harness.outboundTranscript.record).not.toHaveBeenCalled();
    expect(harness.ingress.recordObservedMessage).not.toHaveBeenCalled();
  });

  it("rejects a dirty preflight baseline without writes", async () => {
    const harness = createHarness();
    harness.conversation.needsAttention = true;

    await expect(
      harness.service.preflightScenarioRun(
        {
          campaignId,
          conversationId,
          scenarioId: "greeklish",
          expectedModel: "openai/gpt-5.6-luna",
        },
        correlationId,
      ),
    ).rejects.toThrow("not a clean intro baseline");
    expect(harness.outboundTranscript.record).not.toHaveBeenCalled();
    expect(harness.ingress.recordObservedMessage).not.toHaveBeenCalled();
  });

  it("rejects a partial goal set instead of treating it as a clean launch", async () => {
    const harness = createHarness();
    harness.conversation.goals.pop();

    await expect(
      harness.service.preflightScenarioRun(
        {
          campaignId,
          conversationId,
          scenarioId: "greeklish",
          expectedModel: "openai/gpt-5.6-luna",
        },
        correlationId,
      ),
    ).rejects.toThrow("not a clean intro baseline");
  });

  it("rejects a V1 campaign before spending money on the V2 corpus", async () => {
    const harness = createHarness({}, 1);

    await expect(
      harness.service.preflightScenarioRun(
        {
          campaignId,
          conversationId,
          scenarioId: "greeklish",
          expectedModel: "openai/gpt-5.6-luna",
        },
        correlationId,
      ),
    ).rejects.toThrow("corpus is calibrated for questionnaire V2");
    expect(harness.ingress.recordObservedMessage).not.toHaveBeenCalled();
  });

  it("fails extraction/outbox errors before accepting a cursor and waits for the run outbox sink", () => {
    const completeCursor = {
      injectionFailed: false,
      injectedMessages: 1,
      totalMessages: 1,
      materializedMessages: 1,
      failedMessages: 0,
      currentCursorSeq: 2,
      targetCursorSeq: 2,
      conversationAvailable: true,
      conversationOpen: true,
      extractionActive: false,
      extractionPending: false,
      extractionFailed: false,
      outboxFailed: false,
      outboxMissing: false,
      outboxSettled: false,
    };

    expect(
      runStage({
        ...completeCursor,
        extractionFailed: true,
        outboxSettled: true,
      }),
    ).toBe("failed");
    expect(
      runStage({
        ...completeCursor,
        outboxMissing: true,
      }),
    ).toBe("failed");
    expect(runStage(completeCursor)).toBe("delivering_simulated_outbox");
    expect(
      runStage({
        ...completeCursor,
        outboxSettled: true,
      }),
    ).toBe("processed");
  });

  it("requires the explicit production rehearsal gate", async () => {
    const { service } = createHarness({ NODE_ENV: "production" });

    await expect(service.getCatalog()).rejects.toThrow(
      FeedbackSimulatorRunRejectedError,
    );

    const rehearsal = createHarness({
      NODE_ENV: "production",
      FEEDBACK_PRODUCTION_REHEARSAL_ENABLED: true,
    });
    await expect(rehearsal.service.getCatalog()).resolves.toMatchObject({
      activeModel: "openai/gpt-5.6-luna",
    });
  });
});

function createHarness(
  environment: Partial<Environment> = {},
  questionSetVersion = 2,
  feedbackVenue: {
    readonly contextRevision: number;
    readonly venue: typeof enabledFeedbackVenue.venue | null;
  } = enabledFeedbackVenue,
): {
  service: FeedbackSimulatorService;
  ingress: { recordObservedMessage: ReturnType<typeof vi.fn> };
  outboundTranscript: { record: ReturnType<typeof vi.fn> };
  queue: { getWorkers: ReturnType<typeof vi.fn> };
  conversation: {
    needsAttention: boolean;
    goals: Array<{ key: string; ordinal: number; status: string }>;
  };
} {
  const conversation = {
    _id: conversationId,
    campaignId,
    respondentParticipantId: respondentId,
    phoneAtLaunch: "+306900000000",
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: {
      mode: "bot",
      source: "launch",
      changedAt: new Date("2026-07-26T10:00:00.000Z"),
    },
    goals: [
      {
        key: "event_score",
        ordinal: 1,
        prompt: "score",
        status: "pending",
      },
      {
        key: "table_fit",
        ordinal: 2,
        prompt: "table fit",
        status: "pending",
      },
      {
        key: "participation_ease",
        ordinal: 3,
        prompt: "participation ease",
        status: "pending",
      },
      {
        key: "conversation_balance",
        ordinal: 4,
        prompt: "conversation balance",
        status: "pending",
      },
      {
        key: "meet_again",
        ordinal: 5,
        prompt: "meet again",
        status: "pending",
      },
      {
        key: "avoid",
        ordinal: 6,
        prompt: "avoid",
        status: "pending",
      },
    ],
    messages: [] as Array<{
      id: string;
      actor: "bot";
      text: string;
      seq: number;
      outboxId: string;
      ingressId: null;
    }>,
    extraction: { cursorSeq: 0, lastRunAt: null, model: null },
    needsAttention: false,
  };
  const intro = {
    id: introOutboxId,
    conversationId,
    campaignId,
    kind: "intro",
    body: "Πώς ήταν η βραδιά;",
    status: "sent",
    dedupeKey: "intro:test",
    createdAt: new Date("2026-07-26T10:00:00.000Z"),
  };
  const ingress = {
    recordObservedMessage: vi.fn().mockResolvedValue({
      ingressId,
      inserted: true,
    }),
  };
  const repository = {
    findCampaignById: vi.fn().mockResolvedValue({
      id: campaignId,
      eventId,
      status: "launched",
      questionSetVersion,
    }),
    listAnswersByConversation: vi.fn().mockResolvedValue([]),
    listNotesByConversation: vi.fn().mockResolvedValue([]),
    listOutboxByConversation: vi.fn().mockResolvedValue([intro]),
    listIngressByPhoneE164: vi.fn().mockResolvedValue([]),
    listSimOutboundByPhoneE164: vi.fn().mockResolvedValue([
      {
        id: "99999999-9999-4999-8999-999999999999",
        outboxId: introOutboxId,
      },
    ]),
    findIngressById: vi.fn().mockResolvedValue({
      id: ingressId,
      processingStatus: "pending",
    }),
  };
  const conversations = {
    findById: vi
      .fn()
      .mockImplementation(async () => structuredClone(conversation)),
  };
  const events = {
    findById: vi.fn().mockResolvedValue({
      id: eventId,
      status: "finished",
      venueProvider: "google",
      venuePlaceId: "ChIJ-never-cross-the-preflight-boundary",
    }),
  };
  const eventsService = {
    getFeedbackVenueContext: vi.fn().mockResolvedValue(feedbackVenue),
    listFeedbackCandidatesForRespondent: vi.fn().mockResolvedValue({
      items: [
        {
          participantId: candidateId,
          displayName: "Ada",
        },
      ],
    }),
  };
  const participants = {
    findById: vi.fn().mockResolvedValue({
      id: respondentId,
      postEventFeedbackWhatsappOptIn: true,
    }),
  };
  const outboundTranscript = {
    record: vi.fn().mockImplementation(async () => {
      conversation.messages.push({
        id: "88888888-8888-4888-8888-888888888888",
        actor: "bot",
        text: intro.body,
        seq: 1,
        outboxId: introOutboxId,
        ingressId: null,
      });
      return { outcome: "appended", conversation };
    }),
  };
  const values = {
    NODE_ENV: "test",
    FEEDBACK_SIMULATOR_ENABLED: true,
    TRANSPORT_MODE: "simulated",
    FEEDBACK_EXTRACTION_MODEL: "openai/gpt-5.6-luna",
    FEEDBACK_EXTRACTION_REASONING_EFFORT: "xhigh",
    ...environment,
  };
  const expectedProfile = resolveFeedbackWorkerControlProfile({
    extractionStub: values.FEEDBACK_EXTRACTION_STUB === true,
    model: optionalString(values.FEEDBACK_EXTRACTION_MODEL),
    extractionReasoningEffort: optionalString(
      values.FEEDBACK_EXTRACTION_REASONING_EFFORT,
    ),
    attentionReasoningEffort: optionalString(
      values.FEEDBACK_ATTENTION_REASONING_EFFORT,
    ),
    serviceTier: optionalString(values.FEEDBACK_EXTRACTION_SERVICE_TIER),
  });
  const queue = {
    getJob: vi.fn().mockResolvedValue(undefined),
    getWorkers: vi
      .fn()
      .mockResolvedValue([
        workerInfo(createFeedbackWorkerRegistrationName(expectedProfile)),
      ]),
  };
  const config = {
    get: vi.fn((key: keyof typeof values) => values[key]),
  };

  return {
    service: new FeedbackSimulatorService(
      queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
      config as unknown as ConfigService<Environment, true>,
      ingress as unknown as PostEventFeedbackIngressService,
      repository as unknown as FeedbackCampaignRepository,
      repository as unknown as FeedbackResultsRepository,
      repository as unknown as FeedbackIngressRepository,
      repository as unknown as FeedbackOutboxRepository,
      repository as unknown as FeedbackSimOutboundRepository,
      conversations as unknown as FeedbackConversationRepository,
      events as unknown as EventsRepository,
      eventsService as unknown as EventsService,
      participants as unknown as ParticipantsRepository,
      outboundTranscript as unknown as FeedbackOutboundTranscriptService,
    ),
    ingress,
    outboundTranscript,
    queue,
    conversation,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function workerInfo(registrationName: string): { rawname: string } {
  return {
    rawname: `bull:ZmVlZGJhY2s=:w:${registrationName}`,
  };
}
