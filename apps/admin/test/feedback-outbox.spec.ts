import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * The outbound queue screen (`/admin/outbound`).
 *
 * Its rules live in `src/features/feedback/outboxQueue.ts`, which is React-free
 * and therefore unit-testable here. As in `feedback-inbox.spec.ts`, the real
 * module is loaded through a computed URL so it stays out of this node project's
 * type program while vitest still exercises the shipped implementation.
 */

type QueueStatus = "pending" | "sending" | "held";
type CampaignStatus = "launched" | "paused" | "closed";
type JobState =
  | "waiting"
  | "waiting-children"
  | "prioritized"
  | "delayed"
  | "active"
  | "completed"
  | "failed"
  | "unknown";

interface TestQueueItem {
  id: string;
  status: QueueStatus;
  campaignStatus: CampaignStatus;
  waitingSeconds: number;
  kind: "intro" | "reply" | "reminder" | "staff" | "system";
}

interface TestMessage {
  status: QueueStatus | "sent" | "failed" | "cancelled";
  campaignStatus: CampaignStatus;
  deliveryStatus: string | null;
  providerLogId: string | null;
  providerMessageId: string | null;
  reclaimAt: string | null;
  job: {
    id: string;
    state: JobState;
    attemptsMade: number | null;
    attemptsAllowed: number | null;
    enqueuedAt: string | null;
    dueAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    failedReason: string | null;
  };
}

interface TestConversationState {
  lifecycle: { state: "open" | "closed"; reason: string | null };
  control: { mode: "bot" | "human"; source: string };
  awaitingHuman: boolean;
  needsAttention: boolean;
  unresolvedAttentionCount: number;
  goals: { key: string; status: string }[];
  messageCount: number;
  latestMessageSeq: number | null;
  extractionCursorSeq: number;
  reminderCount: number;
}

interface TestLog {
  origin: string;
  correlationId: string;
  createdAt: string;
  decision: { origin: string } & Record<string, unknown>;
  conversationState: TestConversationState;
}

interface TestFact {
  label: string;
  value: string;
}

interface OutboxQueueModule {
  OUTBOX_LOG_ABSENT_COPY: string;
  outboundOriginLabel: (origin: string) => string;
  outboundDecisionFacts: (log: TestLog, now?: Date) => TestFact[];
  outboundConversationStateFacts: (state: TestConversationState) => TestFact[];
  OUTBOX_WAITING_SLOW_SECONDS: number;
  OUTBOX_WAITING_STALLED_SECONDS: number;
  outboxWaitingTone: (item: {
    status: QueueStatus;
    campaignStatus: CampaignStatus;
    waitingSeconds: number;
  }) => "parked" | "fresh" | "slow" | "stalled";
  formatWaiting: (seconds: number) => string;
  describeWaiting: (seconds: number) => string;
  outboxStatusBadge: (status: QueueStatus) => { label: string; tone: string };
  outboxKindLabel: (kind: TestQueueItem["kind"]) => string;
  deliverJobStateLabel: (state: JobState) => string;
  deliverJobLines: (
    message: TestMessage,
    now?: Date,
  ) => {
    state: string;
    explanation: string;
    attempt: string | null;
    timing: string | null;
    failure: string | null;
    tone: "none" | "pending" | "danger";
  };
  outboxQueueSummary: (view: {
    counts: { pending: number; sending: number; held: number; total: number };
    items: TestQueueItem[];
  }) => {
    total: number;
    oldestWaitingSeconds: number | null;
    worstTone: "parked" | "fresh" | "slow" | "stalled";
  };
}

interface PollingModule {
  OUTBOX_QUEUE_POLL_INTERVAL_MS: number;
  OUTBOX_MESSAGE_POLL_INTERVAL_MS: number;
}

let outbox: OutboxQueueModule;
let polling: PollingModule;

async function loadFeatureModule<T>(relativePath: string): Promise<T> {
  const moduleUrl = new URL(`../${relativePath}`, import.meta.url).href;
  return (await import(moduleUrl)) as T;
}

function readAdminFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

beforeAll(async () => {
  outbox = await loadFeatureModule<OutboxQueueModule>(
    "src/features/feedback/outboxQueue.ts",
  );
  polling = await loadFeatureModule<PollingModule>(
    "src/features/feedback/polling.ts",
  );
});

function item(overrides: Partial<TestQueueItem> = {}): TestQueueItem {
  return {
    id: "1",
    status: "pending",
    campaignStatus: "launched",
    waitingSeconds: 3,
    kind: "reply",
    ...overrides,
  };
}

function message(overrides: Partial<TestMessage> = {}): TestMessage {
  return {
    status: "pending",
    campaignStatus: "launched",
    deliveryStatus: null,
    providerLogId: null,
    providerMessageId: null,
    reclaimAt: null,
    job: {
      id: "feedback-deliver-v1-abc",
      state: "unknown",
      attemptsMade: null,
      attemptsAllowed: null,
      enqueuedAt: null,
      dueAt: null,
      startedAt: null,
      finishedAt: null,
      failedReason: null,
      ...overrides.job,
    },
    ...overrides,
  };
}

function conversationState(
  overrides: Partial<TestConversationState> = {},
): TestConversationState {
  return {
    lifecycle: { state: "open", reason: null },
    control: { mode: "bot", source: "launch" },
    awaitingHuman: false,
    needsAttention: false,
    unresolvedAttentionCount: 0,
    goals: [
      { key: "event_score", status: "answered" },
      { key: "liked", status: "asked" },
      { key: "meet_again", status: "pending" },
      { key: "avoid", status: "pending" },
    ],
    messageCount: 4,
    latestMessageSeq: 6,
    extractionCursorSeq: 5,
    reminderCount: 0,
    ...overrides,
  };
}

function log(overrides: Partial<TestLog> = {}): TestLog {
  return {
    origin: "extraction_reply",
    correlationId: "req-71c",
    createdAt: "2026-07-27T11:40:58.000Z",
    decision: {
      origin: "extraction_reply",
      model: "google/gemini-2.5-flash",
      confidence: 0.84,
      closingReason: null,
      askedGoal: "liked",
      goalStatuses: [
        { key: "event_score", status: "answered" },
        { key: "liked", status: "asked" },
      ],
    },
    conversationState: conversationState(),
    ...overrides,
  };
}

function factValue(facts: TestFact[], label: string): string | undefined {
  return facts.find((fact) => fact.label === label)?.value;
}

describe("age is the number that matters", () => {
  it("separates a normal wait from the shape of the 2026-07-27 incident", () => {
    expect(outbox.outboxWaitingTone(item({ waitingSeconds: 5 }))).toBe("fresh");
    expect(outbox.outboxWaitingTone(item({ waitingSeconds: 30 }))).toBe("slow");
    expect(outbox.outboxWaitingTone(item({ waitingSeconds: 147 }))).toBe(
      "stalled",
    );
  });

  it("takes its thresholds from the relay's own five-second pass", () => {
    // Under 15s a row has had at most two chances to be leased.
    expect(outbox.OUTBOX_WAITING_SLOW_SECONDS).toBe(15);
    expect(outbox.OUTBOX_WAITING_STALLED_SECONDS).toBe(60);
    expect(
      outbox.outboxWaitingTone(
        item({ waitingSeconds: outbox.OUTBOX_WAITING_SLOW_SECONDS - 1 }),
      ),
    ).toBe("fresh");
    expect(
      outbox.outboxWaitingTone(
        item({ waitingSeconds: outbox.OUTBOX_WAITING_STALLED_SECONDS }),
      ),
    ).toBe("stalled");
  });

  it("does not shout at a row the system is deliberately not sending", () => {
    // A paused campaign is never leased and a held row never is either, so an
    // hour of age is obedience, not an incident. Crying wolf here would teach
    // an operator that the colour means nothing.
    expect(
      outbox.outboxWaitingTone(
        item({ waitingSeconds: 3600, campaignStatus: "paused" }),
      ),
    ).toBe("parked");
    expect(
      outbox.outboxWaitingTone(item({ waitingSeconds: 3600, status: "held" })),
    ).toBe("parked");
  });

  it("keeps seconds visible right up to the hour", () => {
    expect(outbox.formatWaiting(8)).toBe("8s");
    expect(outbox.formatWaiting(59)).toBe("59s");
    expect(outbox.formatWaiting(147)).toBe("2m 27s");
    expect(outbox.formatWaiting(3600)).toBe("1h 00m");
    expect(outbox.formatWaiting(-4)).toBe("0s");
  });

  it("gives a screen reader words instead of punctuation", () => {
    expect(outbox.describeWaiting(1)).toBe("1 second");
    expect(outbox.describeWaiting(8)).toBe("8 seconds");
    expect(outbox.describeWaiting(147)).toBe("2 minutes 27 seconds");
    expect(outbox.describeWaiting(120)).toBe("2 minutes");
  });
});

describe("what a row says about itself", () => {
  it("labels a queued row as queued rather than as anything sent", () => {
    expect(outbox.outboxStatusBadge("pending")).toMatchObject({
      label: "Queued",
    });
    expect(outbox.outboxStatusBadge("sending")).toMatchObject({
      label: "Sending",
    });
    expect(outbox.outboxStatusBadge("held")).toMatchObject({
      label: "Held",
      tone: "warning",
    });
  });

  it("names each message kind an operator can meet here", () => {
    expect(outbox.outboxKindLabel("intro")).toBe("Intro");
    expect(outbox.outboxKindLabel("staff")).toBe("Staff message");
    expect(outbox.outboxKindLabel("reminder")).toBe("Reminder");
  });

  it("reports the real backlog and the oldest age from the head of the list", () => {
    const summary = outbox.outboxQueueSummary({
      counts: { pending: 300, sending: 2, held: 4, total: 306 },
      items: [item({ waitingSeconds: 147 }), item({ waitingSeconds: 4 })],
    });

    expect(summary.total).toBe(306);
    expect(summary.oldestWaitingSeconds).toBe(147);
    expect(summary.worstTone).toBe("stalled");
  });

  it("has no oldest age when nothing is waiting", () => {
    expect(
      outbox.outboxQueueSummary({
        counts: { pending: 0, sending: 0, held: 0, total: 0 },
        items: [],
      }).oldestWaitingSeconds,
    ).toBeNull();
  });
});

describe("the delivery job, honestly", () => {
  it("says «άγνωστο» for a job Redis no longer holds", () => {
    expect(outbox.deliverJobStateLabel("unknown")).toBe("άγνωστο");
    expect(outbox.deliverJobLines(message()).state).toBe("άγνωστο");
  });

  it("explains why a queued row has no job instead of implying a fault", () => {
    const lines = outbox.deliverJobLines(message({ status: "pending" }));

    expect(lines.explanation).toContain("relay leases pending rows");
    expect(lines.tone).toBe("none");
  });

  it("states that a held row is never handed to the relay at all", () => {
    expect(
      outbox.deliverJobLines(message({ status: "held" })).explanation,
    ).toContain("never handed to the relay");
  });

  it("names the paused campaign rather than blaming the queue", () => {
    expect(
      outbox.deliverJobLines(
        message({ status: "pending", campaignStatus: "paused" }),
      ).explanation,
    ).toContain("campaign is not running");
  });

  it("admits the three indistinguishable cases for a leased row with no job", () => {
    const lines = outbox.deliverJobLines(
      message({
        status: "sending",
        reclaimAt: "2026-07-27T11:47:00.000Z",
      }),
    );

    expect(lines.explanation).toContain("look the same");
    // Not a spinner: the relay's recovery horizon is a real time to give.
    expect(lines.timing).toContain("reclaims this row");
    expect(lines.tone).toBe("pending");
  });

  it("shows a due time for a delayed job rather than a spinner", () => {
    const lines = outbox.deliverJobLines(
      message({
        status: "sending",
        job: {
          ...message().job,
          state: "delayed",
          dueAt: "2026-07-27T11:41:04.000Z",
        },
      }),
      new Date("2026-07-27T11:41:00.000Z"),
    );

    expect(lines.state).toBe("Delayed");
    expect(lines.timing).toContain("Runs at");
  });

  it("shows failure as failure, with its reason", () => {
    const lines = outbox.deliverJobLines(
      message({
        status: "sending",
        job: {
          ...message().job,
          state: "failed",
          attemptsMade: 1,
          attemptsAllowed: 1,
          failedReason: "wasender_session_unavailable",
        },
      }),
    );

    expect(lines.state).toBe("Failed");
    expect(lines.failure).toBe("wasender_session_unavailable");
    expect(lines.tone).toBe("danger");
  });

  it("answers 'how many attempts' with the only durable fact there is", () => {
    // No attempts table exists, and BullMQ's counter restarts when the relay
    // re-adds the same job id. A recorded provider id is the whole evidence.
    const attempted = outbox.deliverJobLines(
      message({ status: "sending", providerMessageId: "wa-9" }),
    );
    expect(attempted.attempt).toContain("A provider call was made");
    expect(attempted.attempt).toContain("reconciles");

    const notAttempted = outbox.deliverJobLines(
      message({
        status: "sending",
        job: {
          ...message().job,
          state: "active",
          attemptsMade: 0,
          attemptsAllowed: 1,
        },
      }),
    );
    expect(notAttempted.attempt).toContain("Attempt 1 of 1");
    expect(notAttempted.attempt).toContain("PostgreSQL owns recovery");
  });

  it("treats a delivery error as danger even when the job looks fine", () => {
    expect(
      outbox.deliverJobLines(
        message({ status: "sending", deliveryStatus: "error" }),
      ).tone,
    ).toBe("danger");
  });
});

describe("why the row was written", () => {
  it("names what wrote the row and the numbers the model itself reported", () => {
    const facts = outbox.outboundDecisionFacts(
      log(),
      new Date("2026-07-27T11:41:00.000Z"),
    );

    expect(factValue(facts, "Origin")).toBe("Model reply");
    expect(factValue(facts, "Model")).toBe("google/gemini-2.5-flash");
    expect(factValue(facts, "Confidence")).toBe("84%");
    // The goal key is spoken in the inbox's own question vocabulary.
    expect(factValue(facts, "Asked")).toBe("Liked");
    expect(factValue(facts, "Goals it recorded")).toBe(
      "1 answered · 1 awaiting reply",
    );
    expect(factValue(facts, "Correlation id")).toBe("req-71c");
    expect(factValue(facts, "Recorded")).not.toBe("—");
  });

  it("does not invent a confidence the model never reported", () => {
    const facts = outbox.outboundDecisionFacts(
      log({
        decision: {
          origin: "extraction_reply",
          model: "google/gemini-2.5-flash",
          confidence: null,
          closingReason: "completed",
          askedGoal: null,
          goalStatuses: [],
        },
      }),
    );

    expect(factValue(facts, "Confidence")).toBe("not reported");
    expect(factValue(facts, "Asked")).toContain("asked no question");
    expect(factValue(facts, "Closed the thread")).toBe("Completed");
    expect(factValue(facts, "Goals it recorded")).toBe("none");
  });

  it("names each origin an operator can meet, with what that origin turned on", () => {
    expect(outbox.outboundOriginLabel("staff_message")).toBe("Staff message");
    expect(outbox.outboundOriginLabel("extraction_parked_notice")).toBe(
      "Parked notice",
    );

    expect(
      factValue(
        outbox.outboundDecisionFacts(
          log({
            origin: "reminder",
            decision: { origin: "reminder", rung: 2 },
          }),
        ),
        "Rung",
      ),
    ).toBe("2");
    expect(
      factValue(
        outbox.outboundDecisionFacts(
          log({
            origin: "campaign_intro",
            decision: { origin: "campaign_intro", conversationCreated: true },
          }),
        ),
        "Conversation",
      ),
    ).toBe("created with this message");
  });

  it("passes an unrecognised failure cause through instead of flattening it", () => {
    // The log stores the cause as free text so the audit record survives the
    // extractor renaming its classes. A cause this screen has never heard of is
    // still the truest thing it can print.
    const known = outbox.outboundDecisionFacts(
      log({
        origin: "extraction_fallback_ack",
        decision: {
          origin: "extraction_fallback_ack",
          cause: "provider_refusal",
        },
      }),
    );
    expect(factValue(known, "Cause")).toBe("the provider declined to answer");

    const drifted = outbox.outboundDecisionFacts(
      log({
        origin: "extraction_fallback_fence",
        decision: {
          origin: "extraction_fallback_fence",
          cause: "quota_exhausted",
        },
      }),
    );
    expect(factValue(drifted, "Cause")).toBe("quota_exhausted");
  });

  it("reports the conversation as the writer saw it, not as it is now", () => {
    const facts = outbox.outboundConversationStateFacts(conversationState());

    expect(factValue(facts, "Lifecycle")).toBe("Open");
    expect(factValue(facts, "Control")).toBe("Bot control since launch");
    expect(factValue(facts, "Goals")).toBe(
      "1 answered · 1 awaiting reply · 2 not asked",
    );
    expect(factValue(facts, "Attention")).toBe("None");
    expect(factValue(facts, "Messages")).toBe("4, latest #6");
    expect(factValue(facts, "Extraction cursor")).toBe("#5");
    expect(factValue(facts, "Reminders")).toBe("none sent");
  });

  it("says what was waiting on a person and how much of it was unresolved", () => {
    const facts = outbox.outboundConversationStateFacts(
      conversationState({
        lifecycle: { state: "closed", reason: "stopped" },
        control: { mode: "human", source: "staff_action" },
        awaitingHuman: true,
        needsAttention: true,
        unresolvedAttentionCount: 2,
        messageCount: 0,
        latestMessageSeq: null,
        extractionCursorSeq: 0,
        reminderCount: 1,
      }),
    );

    expect(factValue(facts, "Lifecycle")).toBe("Stopped");
    expect(factValue(facts, "Control")).toBe(
      "Human control after a staff action",
    );
    expect(factValue(facts, "Attention")).toBe(
      "Flagged (2 unresolved) · waiting on a person",
    );
    expect(factValue(facts, "Messages")).toBe("0");
    expect(factValue(facts, "Extraction cursor")).toBe("nothing read yet");
    expect(factValue(facts, "Reminders")).toBe("1 sent");
  });

  it("states that an old row predates the log instead of showing an empty section", () => {
    // Hiding the section would teach an operator that the decision log is
    // unreliable. The row is simply older than the table.
    expect(outbox.OUTBOX_LOG_ABSENT_COPY).toContain(
      "before the decision log existed",
    );

    const details = readAdminFile(
      "src/components/admin/feedback/OutboxMessageDetails.tsx",
    );
    expect(details).toContain("OUTBOX_LOG_ABSENT_COPY");
    expect(details).toContain("message.log === null");
    // The decision is durable PostgreSQL, so it sits above the live queue read.
    expect(details.indexOf("Why this was sent")).toBeLessThan(
      details.indexOf('title="Delivery job"'),
    );
  });
});

describe("polling policy", () => {
  it("matches the relay's own pass, on both the list and the opened row", () => {
    expect(polling.OUTBOX_QUEUE_POLL_INTERVAL_MS).toBe(5_000);
    expect(polling.OUTBOX_MESSAGE_POLL_INTERVAL_MS).toBe(5_000);
  });
});

describe("the load constraint the screen exists under", () => {
  it("reads queue state only for the row an operator opened", () => {
    const page = readAdminFile("src/routes/FeedbackOutboxPage.tsx");

    // The polled list hook must not be the one that inspects Redis, and the
    // per-row hook must be gated on a selection.
    expect(page).toContain("useListFeedbackOutboxQueue");
    expect(page).toContain("useGetFeedbackOutboxMessage");
    expect(page).toContain("enabled: selectedId !== null");
    expect(page).toContain('from "../api/generated/feedback-outbox"');
    expect(page).not.toContain("ofetch");
  });

  it("keeps the backend list free of any per-row queue lookup", () => {
    const service = readFileSync(
      fileURLToPath(
        new URL(
          "../../backend/src/modules/post-event-feedback/outbox/queue-view.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    const listBody = service.slice(
      service.indexOf("async listQueue("),
      service.indexOf("async getMessageDelivery("),
    );

    expect(listBody).not.toContain("getJob");
    expect(listBody).not.toContain("inspectFeedbackDeliverJob");
    expect(listBody).toContain("listUndeliveredOutbox");
    // One batched conversation read for the whole page, never one per row.
    expect(listBody).toContain("listRespondentsByIds");
    expect(listBody).not.toContain("findById(");
  });

  it("never announces a page whose every number changes on every poll", () => {
    const list = readAdminFile(
      "src/components/admin/feedback/OutboxQueueList.tsx",
    );
    const details = readAdminFile(
      "src/components/admin/feedback/OutboxMessageDetails.tsx",
    );

    // The extraction block is a polite live region because it is one short
    // sentence that mostly holds still. Every age here ticks every five
    // seconds, so a live region would announce forever.
    expect(list).not.toContain("aria-live");
    expect(details).not.toContain("aria-live");
    // Failures still announce, and the live mark still states in text that the
    // pane refreshes itself.
    expect(list).toContain('role="alert"');
    expect(list).toContain("JtsLiveIndicator");
    expect(details).toContain("JtsLiveIndicator");
  });

  it("shows a state and a time, never an unresolving spinner", () => {
    const details = readAdminFile(
      "src/components/admin/feedback/OutboxMessageDetails.tsx",
    );

    expect(details).toContain("job.state");
    expect(details).toContain("job.timing");
    expect(details).toContain("άγνωστο");
    expect(details).not.toContain("aria-busy");
    expect(details).not.toContain("animate-pulse");
  });
});

describe("route and navigation registration", () => {
  it("registers the route where only one nav row can claim it", () => {
    const app = readAdminFile("src/App.tsx");
    const navigation = readAdminFile(
      "src/components/admin/AdminNavigation.tsx",
    );

    expect(app).toContain('path="outbound"');
    expect(app).toContain("FeedbackOutboxPage");
    expect(navigation).toContain('to: "/admin/outbound"');
    // Nesting it under `/admin/feedback` would leave that row active too,
    // because only `/admin` is `end`-matched.
    expect(navigation).not.toContain('to: "/admin/feedback/outbox"');
  });

  it("colours the screen from tokens alone", () => {
    for (const file of [
      "src/routes/FeedbackOutboxPage.tsx",
      "src/components/admin/feedback/OutboxQueueList.tsx",
      "src/components/admin/feedback/OutboxMessageDetails.tsx",
      "src/features/feedback/outboxQueue.ts",
    ]) {
      const source = readAdminFile(file);
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
      expect(source).not.toMatch(
        /\b(?:bg|text|border)-(?:red|slate|gray|zinc|green|amber|blue)-\d{2,3}\b/u,
      );
      expect(source).not.toContain("dark:");
    }
  });
});
