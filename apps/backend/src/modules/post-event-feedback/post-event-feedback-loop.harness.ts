import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { Environment } from "../../infrastructure/config/environment.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "./post-event-feedback-conversation.repository.js";
import {
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  type FeedbackConversationGoal,
} from "./post-event-feedback-conversation.document.js";
import type { EventsRepository } from "../events/events.repository.js";
import type { EventsService } from "../events/events.service.js";
import type { ParticipantsRepository } from "../participants/participants.repository.js";
import { phoneE164ToChatJid } from "../../integrations/wasender/wasender.jid.js";
import type { FeedbackOperatorAlert } from "./operator-alert.js";
import { FeedbackOutboundTranscriptService } from "./outbox/outbound-transcript.service.js";
import type { FeedbackTransport } from "./outbox/transport.js";
import { MessageOutboxDeliveryService } from "./outbox/deliver.service.js";
import { MessageOutboxRelayService } from "./outbox/relay.service.js";
import { PostEventFeedbackExtractionFallback } from "./extraction/fallback.service.js";
import type { PostEventFeedbackExtractionModel } from "./extraction/model.service.js";
import {
  POST_EVENT_FEEDBACK_FALLBACK_ACK,
  POST_EVENT_FEEDBACK_HANDOFF_REPLY,
} from "./extraction/extraction.schemas.js";
import { PostEventFeedbackExtractor } from "./extraction/extract.service.js";
import { PostEventFeedbackIngressService } from "./ingress/ingress.service.js";
import { PostEventFeedbackConversationService } from "./inbox/conversation.service.js";
import {
  FakeAudit,
  FakeDatabase,
  FakeEvents,
  FakeFeedbackConversations,
  FakeFeedbackRepository,
  FakeOperatorAlert,
  FakeParticipants,
  FEEDBACK_TEST_DEFAULT_JOB_ATTEMPTS,
  RecordingFeedbackTransport,
  type FakeOutboxRow,
} from "./post-event-feedback-doubles.harness.js";
import { PostEventFeedbackMaterializer } from "./ingress/materialize.service.js";
import { PostEventFeedbackMetrics } from "./metrics.service.js";
import type {
  FeedbackAnswerQuestionKey,
  FeedbackNoteType,
} from "@join-the-six/database";
import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  createFeedbackIntroDedupeKey,
  renderPostEventFeedbackCopy,
} from "./question-set.js";
import { PostEventFeedbackIngressProcessor } from "./ingress/ingress.processor.js";
import { PostEventFeedbackProcessor } from "./processor.js";
import type { FeedbackCampaignRepository } from "./campaign/campaign.repository.js";
import type { FeedbackResultsRepository } from "./extraction/results.repository.js";
import type { FeedbackIngressRepository } from "./ingress/ingress.repository.js";
import type { FeedbackOutboxRepository } from "./outbox/outbox.repository.js";
import { PostEventFeedbackSweepService } from "./sweeps/sweep.service.js";
import {
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  boundObservedMessageText,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./jobs.schemas.js";
import { FEEDBACK_SWEEP_EVERY_MS } from "./sweeps/sweep-scheduler.service.js";
import {
  ScriptedExtractionModel,
  SCRIPT_MODEL,
} from "./post-event-feedback-loop-model.harness.js";
import {
  CAMPAIGN_ID,
  DEFAULT_CANDIDATES,
  DEFAULT_PHONE,
  DEFAULT_RESPONDENT,
  EVENT_ID,
  FEEDBACK_LOOP_START,
  FEEDBACK_RECEIVED_KINDS,
  MAX_DRAIN_STEPS,
  PERSON_IDS,
  RELAY_JOB_ID,
  TEST_STAFF_ID,
  parseDuration,
  type ExpectedJobFailure,
  type FeedbackExternalAction,
  type FeedbackLoopOutcome,
  type FeedbackReceivedKind,
  type FeedbackScenario,
  type FeedbackSeedOptions,
  type FeedbackStep,
  type ModelFailure,
  type ScenarioDuration,
} from "./post-event-feedback-loop-scenario.js";

export {
  DEFAULT_RESPONDENT,
  FEEDBACK_RECEIVED_KINDS,
  type AttentionTurn,
  type Cite,
  type ExpectedFeedbackOutcome,
  type ExpectedJobFailure,
  type FeedbackExternalAction,
  type FeedbackLoopOutcome,
  type FeedbackReceivedKind,
  type FeedbackReceivedMessage,
  type FeedbackScenario,
  type FeedbackSeedOptions,
  type FeedbackStep,
  type FeedbackTranscriptEntry,
  type ModelFailure,
  type ModelTurn,
  type ScenarioDuration,
  type ScriptedAnswer,
  type ScriptedAttention,
  type ScriptedNote,
} from "./post-event-feedback-loop-scenario.js";
export {
  ScriptedExtractionModel,
  type ScriptedModelPause,
} from "./post-event-feedback-loop-model.harness.js";

/**
 * Fake-backed behavioural harness for the post-event feedback conversation
 * loop. This is deliberately not an E2E test: no real store, Redis worker or
 * provider participates.
 *
 * The whole loop runs for real — ingress, materializer, extractor, validation,
 * the deterministic fallback, the outbox relay, delivery, the sweeps and the
 * BullMQ processor with its retry classification. Only five things are faked,
 * and each is a genuine boundary: the two stores, the queue, the WhatsApp
 * transport and the model provider (`post-event-feedback-doubles.harness.ts`).
 *
 * ## What a scenario may say
 *
 * **Input** is only ever an external observation or action: a message arrived,
 * an outbound was observed on the shared session, time passed, staff acted, or
 * an upstream campaign/consent gate changed. Nothing reaches into an extractor
 * or mutates a conversation aggregate directly.
 *
 * **Assertions** are outcomes, never mechanism. `outcome()` is the entire
 * assertion vocabulary and it deliberately exposes no job id, no queue state,
 * no delay, no extraction cursor, no goal status, no rejection reason, no
 * ingress processing status and no UUID. Those are all scheduled for deletion
 * by §7 of the loop plan (extraction at rest); a suite that asserts them would
 * have to be rewritten alongside it, which is the opposite of what it is for.
 *
 * ## How to write an assertion that survives a refactor
 *
 * Dozens of scenarios share this harness. If every one pins a full picture, an
 * ordinary code change breaks forty tests and the team spends its life
 * repairing them. So:
 *
 * 1. **Always `toMatchObject`, never `toEqual`, and never a snapshot file.** A
 *    snapshot breaks on every unrelated field, which is exactly the failure
 *    mode this suite must not have.
 * 2. **Assert two to four facts — only what the scenario is about.** A STOP
 *    scenario says nothing about answers. A fragmentation scenario says nothing
 *    about lifecycle. Leaving a key out is not laziness, it is the design.
 * 3. **Never assert model-written text verbatim.** Reply wording comes from the
 *    model and will change. Assert the *kind* and the *count* of what the
 *    participant received (`received: [{ kind: "reply" }]`, or
 *    `receivedCount: { reply: 1 }`). Copy the application owns — the closing
 *    line, the handoff line, the STOP acknowledgement — may be asserted
 *    verbatim, because it is ours.
 * 4. **Transcript order is a first-class assertion.** An out-of-order webhook
 *    can invert what a split thought means, so `transcript` is an ordered list
 *    of `{ who, text, kind }` read the way a human reads the admin pane.
 *    Assert that sequence; never assert `seq`, timestamps or storage order.
 * 5. **Prefer counts and kinds over identities** wherever identity is not the
 *    point of the scenario.
 *
 * The trade is explicit: a looser individual test catches less on its own, and
 * the breadth of the suite is what does the catching instead. That is the
 * right balance here. Do not "improve" this suite by tightening it.
 *
 * ## The known-defect ledger
 *
 * Many scenarios describe behaviour the code gets wrong today. **Never write a
 * test that asserts current broken behaviour as the desired contract.** Keep
 * `expect` as the desired outcome and add `knownCurrent`. The runner requires
 * the observed outcome to match that exact diagnostic subset and requires it
 * not to match the desired outcome. A random worker crash therefore cannot
 * turn a known-defect row green, unlike bare `it.fails`.
 */

// ── The queue ───────────────────────────────────────────────────────────────

interface QueuedJob {
  readonly id: string;
  readonly name: FeedbackJobName;
  readonly data: FeedbackJobData;
  readonly runAt: number;
  readonly attempts: number;
  readonly enqueueSeq: number;
  attemptsMade: number;
}

/**
 * BullMQ's semantics, as far as they are observable from a scenario: an `add`
 * for a job id that is still waiting is a no-op, a completed job releases its
 * id, `delay` is honoured against the test clock, and jobs drain in `runAt`
 * order at concurrency one.
 */
class FakeFeedbackQueue {
  private readonly waiting = new Map<string, QueuedJob>();
  private sequence = 0;

  constructor(private readonly nowMs: () => number) {}

  async add(
    name: FeedbackJobName,
    data: FeedbackJobData,
    options?: { jobId?: string; delay?: number; attempts?: number },
  ): Promise<{ id: string }> {
    this.sequence += 1;
    const id = options?.jobId ?? `${name}-${this.sequence}`;
    if (!this.waiting.has(id)) {
      this.waiting.set(id, {
        id,
        name,
        data,
        runAt: this.nowMs() + (options?.delay ?? 0),
        attempts: options?.attempts ?? FEEDBACK_TEST_DEFAULT_JOB_ATTEMPTS,
        enqueueSeq: this.sequence,
        attemptsMade: 0,
      });
    }
    return { id };
  }

  /**
   * Detail-pane extraction status inspects retained jobs. Map waiting entries
   * onto the BullMQ shape that reader expects; absence stays `null`.
   */
  async getJob(jobId: string): Promise<{
    timestamp: number;
    opts: { delay: number };
    getState: () => Promise<"delayed" | "waiting">;
    failedReason: undefined;
  } | null> {
    const job = this.waiting.get(jobId);
    if (!job) {
      return null;
    }
    const delay = Math.max(0, job.runAt - this.nowMs());
    return {
      timestamp: job.runAt - delay,
      opts: { delay },
      getState: async () => (delay > 0 ? "delayed" : "waiting"),
      failedReason: undefined,
    };
  }

  /** The schedulers run at bootstrap; the harness owns repeat cadence instead. */
  async upsertJobScheduler(): Promise<void> {}

  earliestDue(target: number): QueuedJob | undefined {
    let best: QueuedJob | undefined;
    for (const job of this.waiting.values()) {
      if (job.runAt > target) {
        continue;
      }
      if (
        !best ||
        job.runAt < best.runAt ||
        (job.runAt === best.runAt && job.enqueueSeq < best.enqueueSeq)
      ) {
        best = job;
      }
    }
    return best;
  }

  take(id: string): void {
    this.waiting.delete(id);
  }
}

interface Repeatable {
  readonly id: string;
  readonly name: FeedbackJobName;
  readonly data: FeedbackJobData;
  readonly everyMs: number;
  nextAt: number;
}

// ── The harness ─────────────────────────────────────────────────────────────

export interface FeedbackLoopHarness {
  readonly conversationId: string;
  readonly model: ScriptedExtractionModel;
  readonly transport: RecordingFeedbackTransport;
  readonly conversations: FakeFeedbackConversations;
  readonly repository: FakeFeedbackRepository;
  readonly participants: FakeParticipants;
  readonly events: FakeEvents;
  readonly alerts: FakeOperatorAlert;
  readonly audit: FakeAudit;
  /** Job failures, for debugging a surprising outcome. Not an assertion surface. */
  readonly failures: readonly {
    readonly job: string;
    readonly kind?: ModelFailure;
    readonly error: unknown;
  }[];
  now(): Date;
  advance(after: ScenarioDuration): Promise<void>;
  apply(step: FeedbackStep): Promise<void>;
  run(steps: readonly FeedbackStep[]): Promise<void>;
  outcome(): FeedbackLoopOutcome;
}

/**
 * Builds one campaign, one respondent, one conversation and the whole loop
 * around them, with the clock at {@link FEEDBACK_LOOP_START}.
 *
 * Only `Date` is faked. Promises and the microtask queue stay real — the
 * services are `async` throughout, so faking timers wholesale deadlocks the
 * drain loop. Callers outside {@link runFeedbackScenarios} must restore the
 * clock themselves with `afterEach(() => { vi.useRealTimers(); })`.
 */
export async function createFeedbackLoopHarness(
  seed: FeedbackSeedOptions = {},
): Promise<FeedbackLoopHarness> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FEEDBACK_LOOP_START);

  let nowMs = FEEDBACK_LOOP_START.getTime();
  const now = (): Date => new Date(nowMs);
  const setNow = (value: number): void => {
    nowMs = value;
    vi.setSystemTime(new Date(value));
  };

  const respondentName = seed.respondent ?? DEFAULT_RESPONDENT;
  const candidateNames = seed.candidates ?? [...DEFAULT_CANDIDATES];
  const phone = seed.phone ?? DEFAULT_PHONE;
  const idByName = new Map<string, string>();
  const nameById = new Map<string, string>();
  for (const [index, name] of [respondentName, ...candidateNames].entries()) {
    const id = PERSON_IDS[index];
    if (!id) {
      throw new Error("The harness seeds at most eight people");
    }
    idByName.set(name, id);
    nameById.set(id, name);
  }
  const respondentId = idByName.get(respondentName)!;

  const database = new FakeDatabase();
  const repository = new FakeFeedbackRepository(now);
  const conversations = new FakeFeedbackConversations();
  const participants = new FakeParticipants();
  const events = new FakeEvents();
  const audit = new FakeAudit();
  const alerts = new FakeOperatorAlert();
  const metrics = new PostEventFeedbackMetrics();
  const transport = new RecordingFeedbackTransport(now);
  const model = new ScriptedExtractionModel(conversations, idByName);
  const queue = new FakeFeedbackQueue(() => nowMs);
  const config = {
    get: (key: string) =>
      ({
        FEEDBACK_REMINDER_AFTER_HOURS: 24,
        FEEDBACK_EXPIRE_AFTER_HOURS: 72,
        FEEDBACK_MAX_REMINDERS: 2,
        FEEDBACK_INGRESS_PENDING_RECOVERY_MINUTES: 5,
      })[key],
  } as unknown as ConfigService<Environment, true>;

  const copy = { ...POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy };
  repository.campaigns.set(CAMPAIGN_ID, {
    id: CAMPAIGN_ID,
    eventId: EVENT_ID,
    status: seed.campaign ?? "launched",
    questions: { questionSetVersion: 1, copy },
  });
  participants.rows.set(respondentId, {
    id: respondentId,
    preferredName: respondentName,
    emailNormalized: `${respondentId}@example.test`,
    phoneE164: phone,
    postEventFeedbackWhatsappOptIn: seed.optedIn ?? true,
  });
  for (const name of candidateNames) {
    const id = idByName.get(name)!;
    participants.rows.set(id, {
      id,
      preferredName: name,
      emailNormalized: `${id}@example.test`,
      phoneE164: null,
      postEventFeedbackWhatsappOptIn: true,
    });
  }
  events.candidates = candidateNames.map((name) => ({
    participantId: idByName.get(name)!,
    displayName: name,
  }));

  const conversationId = deriveFeedbackConversationId(
    CAMPAIGN_ID,
    respondentId,
  );
  const wantsIntro = true;
  const goalStatuses: Partial<
    Record<FeedbackAnswerQuestionKey, FeedbackConversationGoal["status"]>
  > = {
    // The catalogue's scenario zero: the intro asked the first question.
    ...(wantsIntro ? { event_score: "asked" as const } : {}),
    ...seed.goals,
  };
  conversations.seed({
    _id: conversationId,
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId: CAMPAIGN_ID,
    respondentParticipantId: respondentId,
    phoneAtLaunch: phone,
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: FEEDBACK_LOOP_START },
    goals: buildFeedbackConversationGoals(copy).map((goal) => ({
      ...goal,
      status: goalStatuses[goal.key] ?? goal.status,
    })),
    messages: [],
    extraction: { cursorSeq: 0, lastRunAt: null, model: null },
    needsAttention: false,
    attentionReasons: [],
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    extractionFallbackAckSent: false,
    createdAt: FEEDBACK_LOOP_START,
    updatedAt: FEEDBACK_LOOP_START,
  });

  // Seeding happens before the tape starts rolling: the intro is an already
  // delivered bot turn, so `received` only ever holds what the scenario caused.
  if (wantsIntro) {
    const intro = repository.seedOutbox({
      conversationId,
      campaignId: CAMPAIGN_ID,
      kind: "intro",
      body: renderPostEventFeedbackCopy(copy.intro, respondentName),
      dedupeKey: createFeedbackIntroDedupeKey(conversationId),
      status: "sent",
      providerLogId: "log-seed-intro",
      providerMessageId: "wa-seed-intro",
      deliveryStatus: "sent",
      sentAt: FEEDBACK_LOOP_START,
    });
    await conversations.appendMessage({
      conversationId,
      actor: "bot",
      text: intro.body,
      at: FEEDBACK_LOOP_START,
      outboxId: intro.id,
    });
  }
  for (const answer of seed.answers ?? []) {
    await repository.insertAnswerIfAbsent({} as never, {
      campaignId: CAMPAIGN_ID,
      conversationId,
      respondentParticipantId: respondentId,
      subjectParticipantId: answer.about
        ? (idByName.get(answer.about) ?? null)
        : null,
      questionKey: answer.question,
      valueInt: answer.value ?? null,
      sourceMessageIds: ["seeded"],
      extractionMeta: { model: SCRIPT_MODEL, confidence: 1, candidateIds: [] },
    });
  }
  if (seed.control === "human") {
    await conversations.takeOver({
      conversationId,
      source: "staff_action",
      at: FEEDBACK_LOOP_START,
    });
  }
  if (seed.closed) {
    await conversations.close({
      conversationId,
      reason: seed.closed,
      at: FEEDBACK_LOOP_START,
    });
  }

  const queuePort = queue as unknown as Queue<
    FeedbackJobData,
    void,
    FeedbackJobName
  >;
  const outboundTranscript = new FeedbackOutboundTranscriptService(
    database as unknown as DatabaseService,
    repository as unknown as FeedbackOutboxRepository,
    conversations as unknown as FeedbackConversationRepository,
  );
  const staffConversations = new PostEventFeedbackConversationService(
    queuePort,
    database as unknown as DatabaseService,
    repository as unknown as FeedbackCampaignRepository,
    repository as unknown as FeedbackResultsRepository,
    repository as unknown as FeedbackOutboxRepository,
    conversations as unknown as FeedbackConversationRepository,
    events as unknown as EventsRepository,
    events as unknown as EventsService,
    participants as unknown as ParticipantsRepository,
    audit as unknown as AuditRepository,
    outboundTranscript,
  );
  const ingress = new PostEventFeedbackIngressService(
    queuePort,
    database as unknown as DatabaseService,
    repository as unknown as FeedbackIngressRepository,
  );
  // Materialization runs on its own queue in production, so it runs on its own
  // processor here. Both are driven by the one fake queue — the harness models
  // ordering and delay, not slot contention — but the class that handles a
  // materialize job is the class that handles it in the deployment.
  const materializer = new PostEventFeedbackMaterializer(
    queuePort,
    database as unknown as DatabaseService,
    repository as unknown as FeedbackCampaignRepository,
    repository as unknown as FeedbackIngressRepository,
    repository as unknown as FeedbackOutboxRepository,
    conversations as unknown as FeedbackConversationRepository,
    participants as unknown as ParticipantsRepository,
    audit as unknown as AuditRepository,
    metrics,
    outboundTranscript,
  );
  const ingressProcessor = new PostEventFeedbackIngressProcessor(materializer);
  const processor = new PostEventFeedbackProcessor(
    materializer,
    new MessageOutboxRelayService(
      queuePort,
      repository as unknown as FeedbackOutboxRepository,
    ),
    new MessageOutboxDeliveryService(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackCampaignRepository,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
      outboundTranscript,
      transport as FeedbackTransport,
    ),
    new PostEventFeedbackExtractor(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackCampaignRepository,
      repository as unknown as FeedbackResultsRepository,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
      events as unknown as EventsService,
      participants as unknown as ParticipantsRepository,
      model as unknown as PostEventFeedbackExtractionModel,
      audit as unknown as AuditRepository,
      metrics,
      outboundTranscript,
      alerts as FeedbackOperatorAlert,
    ),
    new PostEventFeedbackSweepService(
      queuePort,
      config,
      database as unknown as DatabaseService,
      repository as unknown as FeedbackCampaignRepository,
      repository as unknown as FeedbackIngressRepository,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
      participants as unknown as ParticipantsRepository,
      audit as unknown as AuditRepository,
      outboundTranscript,
    ),
    new PostEventFeedbackExtractionFallback(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackCampaignRepository,
      repository as unknown as FeedbackResultsRepository,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
      events as unknown as EventsService,
      audit as unknown as AuditRepository,
      outboundTranscript,
      alerts as FeedbackOperatorAlert,
    ),
  );

  const sweepData = {
    schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
    correlationId: "sweep",
  } as const;
  const repeatables: Repeatable[] = [
    FEEDBACK_JOB_NAMES.sweepRemindersV1,
    FEEDBACK_JOB_NAMES.sweepExpiryV1,
    FEEDBACK_JOB_NAMES.sweepIngressV1,
  ].map((name) => ({
    id: name,
    name,
    data: sweepData,
    everyMs: FEEDBACK_SWEEP_EVERY_MS,
    nextAt: FEEDBACK_LOOP_START.getTime() + FEEDBACK_SWEEP_EVERY_MS,
  }));

  const failures: {
    job: string;
    kind?: ModelFailure;
    error: unknown;
  }[] = [];
  const inboundTexts: string[] = [];
  let observedCounter = 0;

  const runJob = async (job: QueuedJob): Promise<void> => {
    for (;;) {
      try {
        if (job.name === FEEDBACK_JOB_NAMES.extractV1) {
          model.beginRun(
            (job.data as { conversationId: string }).conversationId,
          );
        }
        const target =
          job.name === FEEDBACK_JOB_NAMES.materializeV1
            ? ingressProcessor
            : processor;
        await target.process({
          id: job.id,
          name: job.name,
          data: job.data,
          attemptsMade: job.attemptsMade,
          opts: { attempts: job.attempts },
        } as unknown as Job<FeedbackJobData, void, FeedbackJobName>);
        return;
      } catch (error) {
        job.attemptsMade += 1;
        const kind =
          job.name === FEEDBACK_JOB_NAMES.extractV1
            ? model.takeEmittedFailure()
            : undefined;
        failures.push({
          job: job.name,
          ...(kind ? { kind } : {}),
          error,
        });
        if (
          error instanceof UnrecoverableError ||
          job.attemptsMade >= job.attempts
        ) {
          return;
        }
      }
    }
  };

  const drainTo = async (target: number): Promise<void> => {
    let relayOffered = false;
    const offerRelay = async (): Promise<void> => {
      relayOffered = true;
      await queue.add(
        FEEDBACK_JOB_NAMES.relayOutboxV1,
        {
          schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
          correlationId: RELAY_JOB_ID,
        },
        { jobId: RELAY_JOB_ID, attempts: 1 },
      );
    };

    for (let guard = 0; guard < MAX_DRAIN_STEPS; guard += 1) {
      const job = queue.earliestDue(target);
      const repeat = repeatables
        .filter((candidate) => candidate.nextAt <= target)
        .sort((left, right) => left.nextAt - right.nextAt)[0];
      const nextAt = Math.min(
        job?.runAt ?? Number.POSITIVE_INFINITY,
        repeat?.nextAt ?? Number.POSITIVE_INFINITY,
      );

      if (nextAt === Number.POSITIVE_INFINITY) {
        if (relayOffered) {
          break;
        }
        await offerRelay();
        continue;
      }
      // The relay is not scheduled by anything a scenario controls, so it gets
      // its chance whenever the clock is about to move: an outbox row written
      // at 24h is delivered at 24h, not whenever the next job happens to land.
      if (nextAt > nowMs && !relayOffered) {
        await offerRelay();
        continue;
      }

      setNow(Math.max(nowMs, nextAt));
      if (job && job.runAt <= nextAt) {
        queue.take(job.id);
        await runJob(job);
        if (job.name !== FEEDBACK_JOB_NAMES.relayOutboxV1) {
          relayOffered = false;
        }
        continue;
      }
      if (repeat) {
        const fired: QueuedJob = {
          id: `${repeat.id}:${repeat.nextAt}`,
          name: repeat.name,
          data: repeat.data,
          runAt: repeat.nextAt,
          attempts: 1,
          enqueueSeq: 0,
          attemptsMade: 0,
        };
        repeat.nextAt += repeat.everyMs;
        await runJob(fired);
        relayOffered = false;
      }
    }
    setNow(target);
  };

  const advance = async (after: ScenarioDuration): Promise<void> => {
    await drainTo(nowMs + parseDuration(after));
  };

  const applyExternalAction = async (
    action: FeedbackExternalAction,
  ): Promise<void> => {
    observedCounter += 1;
    if (action.kind === "inbound") {
      const bounded = boundObservedMessageText(action.text);
      if (action.text !== null) {
        inboundTexts.push(action.text.trim());
      }
      const from = action.from ?? phone;
      await ingress.recordObservedMessage(
        {
          providerMessageId:
            action.providerMessageId ?? `wa-in-${observedCounter}`,
          chatJid: phoneE164ToChatJid(from),
          direction: "inbound",
          phoneE164: from,
          text: bounded,
          observedAt:
            action.observedAt !== undefined
              ? new Date(
                  FEEDBACK_LOOP_START.getTime() +
                    parseDuration(action.observedAt),
                )
              : now(),
        },
        `corr-${observedCounter}`,
      );
    } else if (action.kind === "observed_outbound") {
      await ingress.recordObservedMessage(
        {
          providerMessageId:
            action.providerMessageId ?? `wa-obs-${observedCounter}`,
          chatJid: phoneE164ToChatJid(phone),
          direction: "outbound",
          phoneE164: phone,
          text: boundObservedMessageText(action.text),
          observedAt:
            action.observedAt !== undefined
              ? new Date(
                  FEEDBACK_LOOP_START.getTime() +
                    parseDuration(action.observedAt),
                )
              : now(),
        },
        `corr-${observedCounter}`,
      );
    } else if (action.kind === "staff") {
      const requestId = `staff-action-${observedCounter}`;
      if (action.action === "send") {
        await staffConversations.sendStaffMessage(
          CAMPAIGN_ID,
          conversationId,
          action.text,
          TEST_STAFF_ID,
          requestId,
        );
      } else if (action.action === "take_over") {
        await staffConversations.takeOver(
          CAMPAIGN_ID,
          conversationId,
          TEST_STAFF_ID,
          requestId,
        );
      } else if (action.action === "resume") {
        await staffConversations.resumeBot(
          CAMPAIGN_ID,
          conversationId,
          TEST_STAFF_ID,
          requestId,
        );
      } else if (action.action === "close") {
        await staffConversations.close(
          CAMPAIGN_ID,
          conversationId,
          { reason: "other" },
          TEST_STAFF_ID,
          requestId,
        );
      }
    } else if (action.kind === "campaign") {
      const campaign = repository.campaigns.get(CAMPAIGN_ID);
      if (!campaign) {
        throw new Error("The harness campaign disappeared");
      }
      campaign.status = action.status;
    } else if (action.kind === "consent") {
      await database.transaction(async (transaction) => {
        await participants.updateFeedbackOptIn(
          transaction,
          respondentId,
          action.optedIn,
        );
      });
    } else {
      transport.outcome = action.outcome;
    }
  };

  const apply = async (step: FeedbackStep): Promise<void> => {
    if (step.kind === "during_model") {
      const pause = model.pauseNext("extraction");
      const running = advance(step.after);
      try {
        await Promise.race([
          pause.started,
          running.then(() => {
            throw new Error(
              "during_model expected an extraction provider call, but the worker settled without one",
            );
          }),
        ]);
      } catch (error) {
        pause.release();
        throw error;
      }

      let actionError: unknown;
      try {
        await applyExternalAction(step.action);
      } catch (error) {
        actionError = error;
      }
      pause.release();
      await running;
      if (actionError) {
        throw actionError;
      }
      return;
    }

    await advance(step.after ?? 0);
    if (step.kind !== "wait") {
      await applyExternalAction(step);
    }
    await drainTo(nowMs);
  };

  const outcome = (): FeedbackLoopOutcome => {
    const conversation = conversations.get(conversationId);
    const outboxById = new Map(
      repository.outbox.map((row) => [row.id, row] as const),
    );
    const kindOf = (row: FakeOutboxRow | undefined): FeedbackReceivedKind =>
      row ? classifyOutbound(row, copy.closing) : "reply";

    const received = transport.sent.map((sent) => ({
      kind: kindOf(outboxById.get(sent.outboxId)),
      text: sent.text,
    }));
    const receivedCount = Object.fromEntries(
      FEEDBACK_RECEIVED_KINDS.map((kind) => [
        kind,
        received.filter((message) => message.kind === kind).length,
      ]),
    ) as Record<FeedbackReceivedKind, number>;

    // Raw ingress is an audit/recovery boundary, not a human-facing inbox.
    // Words count as retained only when the conversation transcript exposes
    // them to an operator.
    const humanVisibleParticipantText = new Set(
      conversation.messages
        .filter((message) => message.actor === "participant")
        .map((message) => message.text),
    );

    return {
      lifecycle: conversation.lifecycle.state,
      closedBecause: conversation.lifecycle.reason,
      control: conversation.control.mode,
      optedIn:
        participants.rows.get(respondentId)?.postEventFeedbackWhatsappOptIn ??
        false,
      answers: repository.answers
        .filter((row) => row.conversationId === conversationId)
        .map((row) => ({
          question: row.questionKey as FeedbackAnswerQuestionKey,
          about: row.subjectParticipantId
            ? (nameById.get(row.subjectParticipantId) ?? "unknown person")
            : null,
          value: row.valueInt,
        }))
        .sort(
          (left, right) =>
            questionOrdinal(left.question) - questionOrdinal(right.question) ||
            (left.about ?? "").localeCompare(right.about ?? ""),
        ),
      notes: repository.notes
        .filter((row) => row.conversationId === conversationId)
        .map((row) => ({
          type: row.noteType as FeedbackNoteType,
          text: row.text,
          about: row.subjectParticipantId
            ? (nameById.get(row.subjectParticipantId) ?? "unknown person")
            : null,
          flagged: row.extractionMeta["flaggedForReview"] === true,
        })),
      needsAttention: conversation.needsAttention,
      flaggedMessages: conversation.messages.flatMap((message) =>
        message.attention
          ? [
              {
                text: message.text,
                categories: message.attention.categories,
                action: message.attention.recommendedAction,
              },
            ]
          : [],
      ),
      alerts: alerts.raised.map((alert) => ({
        reason: alert.reason,
        detail: [...(alert.detail ?? [])],
      })),
      received,
      receivedCount,
      transcript: conversation.messages.map((message) => ({
        who: message.actor,
        text: message.text,
        kind:
          message.actor === "participant"
            ? null
            : kindOf(
                message.outboxId ? outboxById.get(message.outboxId) : undefined,
              ),
      })),
      retainedParticipantText: inboundTexts.filter((text) =>
        humanVisibleParticipantText.has(text),
      ),
      lostParticipantText: inboundTexts.filter(
        (text) => !humanVisibleParticipantText.has(text),
      ),
    };
  };

  return {
    conversationId,
    model,
    transport,
    conversations,
    repository,
    participants,
    events,
    alerts,
    audit,
    failures,
    now,
    advance,
    apply,
    async run(steps) {
      for (const step of steps) {
        await apply(step);
      }
    },
    outcome,
  };
}

function questionOrdinal(key: FeedbackAnswerQuestionKey): number {
  return POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.findIndex(
    (question) => question.key === key,
  );
}

/**
 * What the participant experienced receiving, derived from the copy the
 * application owns rather than from a dedupe key, so the classification
 * survives a change of keying scheme.
 */
function classifyOutbound(
  row: FakeOutboxRow,
  closing: string,
): FeedbackReceivedKind {
  if (row.kind === "intro") {
    return "intro";
  }
  if (row.kind === "reminder") {
    return "reminder";
  }
  if (row.kind === "staff") {
    return "staff";
  }
  if (row.kind === "system") {
    // Both are application-owned `system` copy; the dedupe key is what says
    // which, and it is stable in a way the wording is not.
    return row.dedupeKey.startsWith("feedback-media-notice-")
      ? "media_notice"
      : "stop_ack";
  }
  const body = row.body.trim();
  if (body === closing.trim()) {
    return "closing";
  }
  if (body === POST_EVENT_FEEDBACK_HANDOFF_REPLY) {
    return "handoff";
  }
  if (body.startsWith(POST_EVENT_FEEDBACK_FALLBACK_ACK)) {
    return "fallback";
  }
  return "reply";
}

// ── The runner ──────────────────────────────────────────────────────────────

/**
 * Scenarios are data rows and one runner, not dozens of hand-written functions.
 * Known defects carry two explicit oracles: today's exact observable subset and
 * the desired product subset. Arbitrary exceptions never count as a reproduced
 * defect.
 */
export function runFeedbackScenarios(
  suite: string,
  scenarios: readonly FeedbackScenario[],
): void {
  describe(suite, () => {
    beforeAll(() => {
      Logger.overrideLogger(false);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    for (const scenario of scenarios) {
      const title = scenario.defect
        ? `${scenario.id} — ${scenario.title} [known defect: ${scenario.defect}]`
        : `${scenario.id} — ${scenario.title}`;

      it(title, async () => {
        const harness = await createFeedbackLoopHarness(scenario.seed);
        harness.model.script(
          scenario.script ?? [],
          scenario.allowUnscriptedExtractionCalls ?? false,
        );
        harness.model.scriptAttention(scenario.attention ?? []);
        await harness.run(scenario.steps);

        expect(
          summarizeJobFailures(harness.failures),
          "Background job failures differed from the scenario's explicit provider-failure contract",
        ).toEqual(summarizeExpectedJobFailures(scenario.expectedJobFailures));
        expect(
          harness.model.unconsumedExtractionCalls,
          scriptConsumptionMessage(
            "extraction",
            harness.model.unconsumedExtractionCalls,
          ),
        ).toEqual([]);
        expect(
          harness.model.unconsumedAttentionCalls,
          scriptConsumptionMessage(
            "attention",
            harness.model.unconsumedAttentionCalls,
          ),
        ).toEqual([]);

        const actual = harness.outcome();
        if (scenario.defect) {
          expect(
            actual,
            `Known defect "${scenario.defect}" changed its observable outcome; update or remove knownCurrent`,
          ).toMatchObject(scenario.knownCurrent);
          expect(
            actual,
            `Known defect "${scenario.defect}" now satisfies the desired outcome; remove defect and knownCurrent`,
          ).not.toMatchObject(scenario.expect);
        } else {
          expect(actual).toMatchObject(scenario.expect);
        }
      });
    }
  });
}

interface SummarizedJobFailure {
  readonly job: string;
  readonly kind: ModelFailure | "unexpected";
  readonly count: number;
}

function summarizeJobFailures(
  failures: FeedbackLoopHarness["failures"],
): SummarizedJobFailure[] {
  return summarizeFailureEntries(
    failures.map((failure) => ({
      job: failure.job,
      kind: failure.kind ?? ("unexpected" as const),
      count: 1,
    })),
  );
}

function summarizeExpectedJobFailures(
  failures: readonly ExpectedJobFailure[] | undefined,
): SummarizedJobFailure[] {
  return summarizeFailureEntries(failures ?? []);
}

function summarizeFailureEntries(
  failures: readonly SummarizedJobFailure[],
): SummarizedJobFailure[] {
  const counts = new Map<string, SummarizedJobFailure>();
  for (const failure of failures) {
    const key = `${failure.job}\u0000${failure.kind}`;
    const current = counts.get(key);
    counts.set(key, {
      job: failure.job,
      kind: failure.kind,
      count: (current?.count ?? 0) + failure.count,
    });
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.job.localeCompare(right.job) || left.kind.localeCompare(right.kind),
  );
}

function scriptConsumptionMessage(
  script: "extraction" | "attention",
  calls: readonly number[],
): string {
  return calls.length === 0
    ? `${script} script was consumed`
    : `${script} script left ${calls.length} unconsumed turn(s): call ${calls.join(
        ", ",
      )}`;
}
