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

type QueueStatus =
  "pending" | "claimed" | "attempting" | "ambiguous" | "sending" | "held";
type CampaignStatus = "launched" | "paused" | "closed";

interface TestQueueItem {
  id: string;
  status: QueueStatus;
  campaignStatus: CampaignStatus;
  waitingSeconds: number;
  kind: "intro" | "reply" | "reminder" | "staff" | "system";
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

/**
 * The pane renders each fact by its `kind`, so the kind is part of the module's
 * contract and not a detail of the component that consumes it.
 */
interface TestFact {
  label: string;
  kind: "text" | "id" | "timestamp" | "model" | "confidence";
  value: string;
  provider?: "openai" | "generic";
  ratio?: number | null;
}

interface OutboxQueueModule {
  OUTBOX_LOG_ABSENT_COPY: string;
  outboundOriginLabel: (origin: string) => string;
  outboundDecisionFacts: (log: TestLog, now?: Date) => TestFact[];
  outboundConversationStateFacts: (state: TestConversationState) => TestFact[];
  outboundModelProvider: (model: string) => "openai" | "generic";
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
  outboxHistoryStatusBadge: (
    status: QueueStatus | "sent" | "failed" | "cancelled",
  ) => { label: string; tone: string };
  outboxKindLabel: (kind: TestQueueItem["kind"]) => string;
  deliveryActivityLines: (
    dispatch: TestDispatch,
    now?: Date,
  ) => {
    state: string;
    explanation: string;
    attempt: string | null;
    timing: string | null;
    recordedReason: string | null;
    tone: "none" | "pending" | "danger";
  };
  outboxQueueSummary: (view: {
    counts: {
      pending: number;
      claimed: number;
      attempting: number;
      ambiguous: number;
      sending: number;
      held: number;
      total: number;
    };
    items: TestQueueItem[];
  }) => {
    total: number;
    oldestWaitingSeconds: number | null;
    worstTone: "parked" | "fresh" | "slow" | "stalled";
  };
  formatDelta: (milliseconds: number) => string;
  outboundDeliveryTimeline: (
    input: { message: TestTimelineMessage; dispatch: TestDispatch },
    now?: Date,
  ) => {
    key: string;
    label: string;
    at: string;
    sincePrevious: string | null;
    terminal: boolean;
  }[];
  outboxProviderReadingBadge: (
    deliveryStatus:
      "error" | "pending" | "sent" | "delivered" | "read" | "played" | null,
  ) => { label: string; tone: string } | null;
  OUTBOX_HISTORY_RANGES: readonly { key: RangeKey; label: string }[];
  outboxHistoryRangeFrom: (key: RangeKey, now?: Date) => string | undefined;
  isOutboxHistoryRangeKey: (value: string | null) => boolean;
  OUTBOX_HISTORY_STATUS_FILTERS: readonly {
    key: HistoryStatus | "any";
    label: string;
  }[];
  isOutboxHistoryStatus: (value: string | null) => boolean;
}

interface TestDispatch {
  state:
    | "pending"
    | "claimed"
    | "attempting"
    | "ambiguous"
    | "sending"
    | "sent"
    | "failed"
    | "held"
    | "cancelled";
  claimExpiresAt: string | null;
  sendStartedAt: string | null;
  attemptCount: number;
  lastError: string | null;
}

type RangeKey = "hour" | "today" | "week" | "all";
type HistoryStatus = QueueStatus | "sent" | "failed" | "cancelled";

interface TestTimelineMessage {
  status: HistoryStatus;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  playedAt: string | null;
}

interface PollingModule {
  OUTBOX_QUEUE_POLL_INTERVAL_MS: number;
  OUTBOX_MESSAGE_POLL_INTERVAL_MS: number;
  OUTBOX_HISTORY_POLL_INTERVAL_MS: number;
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

function dispatch(overrides: Partial<TestDispatch> = {}): TestDispatch {
  return {
    state: "pending",
    claimExpiresAt: null,
    sendStartedAt: null,
    attemptCount: 0,
    lastError: null,
    ...overrides,
  };
}

function deliveryTimeline(message: TestTimelineMessage, now?: Date) {
  return outbox.outboundDeliveryTimeline(
    { message, dispatch: dispatch({ state: message.status }) },
    now,
  );
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

function fact(facts: TestFact[], label: string): TestFact | undefined {
  return facts.find((candidate) => candidate.label === label);
}

function factValue(facts: TestFact[], label: string): string | undefined {
  return fact(facts, label)?.value;
}

describe("age is the number that matters", () => {
  it("separates a normal wait from the shape of the 2026-07-27 incident", () => {
    expect(outbox.outboxWaitingTone(item({ waitingSeconds: 5 }))).toBe("fresh");
    expect(outbox.outboxWaitingTone(item({ waitingSeconds: 30 }))).toBe("slow");
    expect(outbox.outboxWaitingTone(item({ waitingSeconds: 147 }))).toBe(
      "stalled",
    );
  });

  it("leaves provider pacing headroom before it raises an incident tone", () => {
    // The dispatcher scans each second, but claiming, pacing and transport all
    // take real time. Fifteen seconds is headroom, not a count of scan passes.
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
    expect(outbox.outboxStatusBadge("claimed")).toMatchObject({
      label: "Claimed",
      tone: "info",
    });
    expect(outbox.outboxStatusBadge("attempting")).toMatchObject({
      label: "Sending",
      tone: "info",
    });
    expect(outbox.outboxStatusBadge("ambiguous")).toMatchObject({
      label: "Reconciliation required",
      tone: "danger",
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
      counts: {
        pending: 300,
        claimed: 0,
        attempting: 0,
        ambiguous: 0,
        sending: 2,
        held: 4,
        total: 306,
      },
      items: [item({ waitingSeconds: 147 }), item({ waitingSeconds: 4 })],
    });

    expect(summary.total).toBe(306);
    expect(summary.oldestWaitingSeconds).toBe(147);
    expect(summary.worstTone).toBe("stalled");
  });

  it("has no oldest age when nothing is waiting", () => {
    expect(
      outbox.outboxQueueSummary({
        counts: {
          pending: 0,
          claimed: 0,
          attempting: 0,
          ambiguous: 0,
          sending: 0,
          held: 0,
          total: 0,
        },
        items: [],
      }).oldestWaitingSeconds,
    ).toBeNull();
  });
});

describe("the durable dispatcher, honestly", () => {
  it("distinguishes a safe claim from a provider attempt", () => {
    const lines = outbox.deliveryActivityLines(
      dispatch({
        state: "claimed",
        claimExpiresAt: "2026-07-27T11:47:00.000Z",
      }),
      new Date("2026-07-27T11:41:00.000Z"),
    );

    expect(lines.state).toBe("Claimed");
    expect(lines.explanation).toContain("no provider attempt");
    expect(lines.timing).toContain("may then be reclaimed");
  });

  it("never promises automatic reclaim after the provider attempt starts", () => {
    const lines = outbox.deliveryActivityLines(
      dispatch({
        state: "attempting",
        sendStartedAt: "2026-07-27T11:41:00.000Z",
        attemptCount: 1,
      }),
    );

    expect(lines.explanation).toContain(
      "not automatically reclaimed or resent",
    );
    expect(lines.attempt).toContain("recorded durably");
  });

  it("blocks blind resend when the provider outcome is ambiguous", () => {
    const lines = outbox.deliveryActivityLines(
      dispatch({
        state: "ambiguous",
        sendStartedAt: "2026-07-27T11:41:00.000Z",
        attemptCount: 1,
        lastError: "transport_timeout",
      }),
    );

    expect(lines.state).toBe("Needs reconciliation");
    expect(lines.explanation).toContain("Automatic resend is blocked");
    expect(lines.recordedReason).toBe("Recorded reason: transport_timeout");
    expect(lines.tone).toBe("danger");
  });

  it("keeps bridge-only sending visible without treating it as reclaimable", () => {
    const lines = outbox.deliveryActivityLines(dispatch({ state: "sending" }));

    expect(lines.state).toBe("Legacy delivery");
    expect(lines.explanation).toContain("does not reclaim it");
    expect(lines.attempt).toContain("pre-cutover");
    expect(lines.timing).toBeNull();
  });

  it("does not turn a zero backfilled counter into proof that an old send never happened", () => {
    const lines = outbox.deliveryActivityLines(
      dispatch({ state: "sent", attemptCount: 0 }),
    );

    expect(lines.attempt).toContain("pre-cutover");
    expect(lines.attempt).not.toContain("has started");
  });

  it("maps every remaining durable state without consulting a job", () => {
    for (const [state, label, tone] of [
      ["pending", "Pending", "none"],
      ["sent", "Sent", "none"],
      ["failed", "Failed", "danger"],
      ["held", "Held", "none"],
      ["cancelled", "Cancelled", "none"],
    ] as const) {
      const lines = outbox.deliveryActivityLines(
        dispatch({
          state,
          attemptCount: state === "sent" || state === "failed" ? 1 : 0,
          lastError: state === "failed" ? "provider_rejected" : null,
        }),
      );

      expect(lines).toMatchObject({ state: label, tone });
    }
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
    expect(factValue(facts, "Asked")).toBe("Liked (V1)");
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

  it("dates a decision to the millisecond, not to the minute", () => {
    const facts = outbox.outboundDecisionFacts(
      log({ createdAt: "2026-07-27T11:40:58.472Z" }),
      new Date("2026-07-27T11:41:00.000Z"),
    );
    const recorded = fact(facts, "Recorded");

    expect(recorded?.kind).toBe("timestamp");
    // Two decisions 67 seconds apart is the comparison an operator opened this
    // row to make, and the minute the rest of the admin shows hides it. The
    // transcript's own clock is untouched — this is a second formatter, not a
    // new meaning for time everywhere.
    expect(recorded?.value).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/u);
  });

  it("marks a model with the only provenance the record supports", () => {
    expect(outbox.outboundModelProvider("openai/gpt-5.6-terra")).toBe("openai");
    // Routed through OpenRouter, and not a logo this repo may redraw on
    // somebody else's behalf: the neutral mark is the honest one.
    expect(outbox.outboundModelProvider("qwen/qwen3.7-max")).toBe("generic");
    expect(outbox.outboundModelProvider("google/gemini-2.5-flash")).toBe(
      "generic",
    );

    const model = fact(outbox.outboundDecisionFacts(log()), "Model");
    expect(model?.kind).toBe("model");
    expect(model?.provider).toBe("generic");
  });

  it("hands over the confidence number itself, not only its words", () => {
    const reported = fact(outbox.outboundDecisionFacts(log()), "Confidence");

    expect(reported?.kind).toBe("confidence");
    // The bar the pane draws is decoration; this number is the fact, and both
    // read the same rounding so they can never disagree.
    expect(reported?.ratio).toBe(0.84);
    expect(reported?.value).toBe("84%");

    const silent = fact(
      outbox.outboundDecisionFacts(
        log({
          decision: {
            origin: "extraction_reply",
            model: "google/gemini-2.5-flash",
            confidence: null,
            closingReason: null,
            askedGoal: null,
            goalStatuses: [],
          },
        }),
      ),
      "Confidence",
    );
    // No ratio means no bar. An empty track would read as zero confidence,
    // which is a far stronger claim than «the model reported none».
    expect(silent?.ratio).toBeNull();
    expect(silent?.value).toBe("not reported");
  });

  it("says which facts are ids, and which only look like one", () => {
    expect(
      fact(outbox.outboundDecisionFacts(log()), "Correlation id")?.kind,
    ).toBe("id");
    expect(
      fact(
        outbox.outboundDecisionFacts(
          log({
            origin: "stop_ack",
            decision: {
              origin: "stop_ack",
              sourceIngressId: "0f2c6b1e-4a77-4f3e-9c11-8b2d5e6a1c30",
            },
          }),
        ),
        "From inbound message",
      )?.kind,
    ).toBe("id");

    // A staff actor is an id in production and a name on older rows. Only the
    // id may be truncated: eight characters of «Μαρία Παπαδοπούλου» is not a
    // name any more.
    expect(
      fact(
        outbox.outboundDecisionFacts(
          log({
            origin: "staff_message",
            decision: {
              origin: "staff_message",
              staffActorId: "user_example_staff",
            },
          }),
        ),
        "Written by",
      )?.kind,
    ).toBe("id");
    expect(
      fact(
        outbox.outboundDecisionFacts(
          log({
            origin: "staff_message",
            decision: {
              origin: "staff_message",
              staffActorId: "Μαρία Παπαδοπούλου",
            },
          }),
        ),
        "Written by",
      )?.kind,
    ).toBe("text");
  });

  it("renders those kinds in the pane, and fetches nothing to do it", () => {
    const details = readAdminFile(
      "src/components/admin/feedback/OutboxMessageDetails.tsx",
    );
    const copyable = readAdminFile(
      "src/components/admin/feedback/CopyableId.tsx",
    );
    const mark = readAdminFile(
      "src/components/admin/feedback/ProviderMark.tsx",
    );

    expect(details).toContain("<CopyableId");
    expect(details).toContain("<ProviderMark");
    // Timestamps are formatted in the React-free module now — the pane paints
    // the pill, the builder decides what goes in it.
    expect(details).toContain("<TimestampPill");
    // Nullable confidence keeps its words and gets no track.
    expect(details).toContain("ConfidenceValue");
    expect(details).toContain("ratio === null");

    // One click puts the whole id on the clipboard; the truncated form is only
    // what is shown, and `title` keeps the full value one hover away.
    expect(copyable).toContain("navigator.clipboard?.writeText");
    expect(copyable).toContain("title={value}");
    expect(copyable).toContain("aria-label={copied ?");

    // The mark is inline: an incident surface must not wait on the network for
    // an icon, and it stays decorative.
    expect(mark).toContain("<svg");
    expect(mark).toContain('aria-hidden="true"');
    expect(mark).not.toContain("http");
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
    // The durable decision sits above the durable dispatch activity.
    expect(details.indexOf("Why this was sent")).toBeLessThan(
      details.indexOf('title="Dispatch activity"'),
    );
  });
});

describe("polling policy", () => {
  it("samples queue and opened-row state every five seconds", () => {
    expect(polling.OUTBOX_QUEUE_POLL_INTERVAL_MS).toBe(3_000);
    expect(polling.OUTBOX_MESSAGE_POLL_INTERVAL_MS).toBe(3_000);
  });

  it("lets the history breathe slower — it is an archive, not a wait", () => {
    expect(polling.OUTBOX_HISTORY_POLL_INTERVAL_MS).toBe(5_000);
  });
});

describe("the history half", () => {
  it("names every status a row can ever reach, reusing the queue's words", () => {
    for (const [status, label] of [
      ["pending", "Queued"],
      ["claimed", "Claimed"],
      ["attempting", "Sending"],
      ["ambiguous", "Reconciliation required"],
      ["sending", "Sending"],
      ["held", "Held"],
      ["sent", "Sent"],
      ["failed", "Failed"],
      ["cancelled", "Cancelled"],
    ] as const) {
      expect(outbox.outboxHistoryStatusBadge(status).label).toBe(label);
    }
    expect(outbox.outboxHistoryStatusBadge("sent").tone).toBe("success");
    expect(outbox.outboxHistoryStatusBadge("failed").tone).toBe("danger");
    // Identical colouring to the queue list for the shared statuses, so the
    // same word never changes meaning between the two views.
    expect(outbox.outboxHistoryStatusBadge("held").tone).toBe(
      outbox.outboxStatusBadge("held").tone,
    );
  });

  it("leads each row with the decision origin, kind only as the fallback", () => {
    const list = readAdminFile(
      "src/components/admin/feedback/OutboxHistoryList.tsx",
    );

    expect(list).toContain("outboundOriginLabel(item.origin)");
    expect(list).toContain("outboxKindLabel(item.kind)");
    expect(list.indexOf("outboxKindLabel")).toBeLessThan(
      list.indexOf("outboundOriginLabel(item.origin)"),
    );
  });

  it("is the default view, with the queue reachable from its own tab", () => {
    const page = readAdminFile("src/routes/FeedbackOutboxPage.tsx");

    expect(page).toContain("useListFeedbackOutboxHistory");
    // History is what the bare URL shows. The queue is the explicit one,
    // because its healthy answer is an empty list and that is a poor front
    // door for the screen people come here to read.
    expect(page).toContain('searchParams.get("view") === "queue" ? "queue"');
    expect(page).toContain('enabled: view === "history"');
    // The selection survives the toggle: a row means the same thing in both.
    expect(page).toContain('view === "history" ||');
  });

  it("keeps an opened message across pages, but not past its own wait", () => {
    const page = readAdminFile("src/routes/FeedbackOutboxPage.tsx");

    // The queue drops a selection the moment the row stops waiting — a pane
    // describing a wait that is over is worse than no pane.
    expect(page).toContain(
      "queueItems.some((item) => item.id === requestedId)",
    );
    // The history does not, and that now covers paging: the opened row is
    // fetched by id and knows nothing about pages, so walking back through the
    // log while keeping one message on screen is what an operator paged for.
    expect(page).not.toContain("historyItems.some((item)");
  });

  it("keeps the queue polling in both views, so its count can still call out", () => {
    const page = readAdminFile("src/routes/FeedbackOutboxPage.tsx");

    const queueHook = page.slice(
      page.indexOf("useListFeedbackOutboxQueue({"),
      page.indexOf("const historyQuery"),
    );
    // Leaving the queue view must not mean losing sight of a backlog. The
    // count rides on the tab, which means the query cannot be view-gated.
    expect(queueHook).not.toContain("enabled:");
    expect(queueHook).toContain("OUTBOX_QUEUE_POLL_INTERVAL_MS");
    // Zero is drawn quietly rather than hidden — a badge that vanishes states
    // nothing, while «0» states the question was asked and answered.
    expect(page).toContain("count === 0");
  });
});

describe("paging the log", () => {
  it("walks by cursor and never prints a page number", () => {
    const page = readAdminFile("src/routes/FeedbackOutboxPage.tsx");
    const list = readAdminFile(
      "src/components/admin/feedback/OutboxHistoryList.tsx",
    );

    // Keyset, not offset: rows are appended while an operator reads, and
    // `OFFSET` against a growing log repeats and skips rows.
    expect(page).toContain("nextCursor");
    expect(page).toContain("setCursors");
    expect(page).not.toMatch(/\boffset\b/iu);
    // «Page 3 of 40» would be stale before it rendered, so neither the page
    // nor the list computes one.
    expect(list).not.toMatch(/page \d|pageCount|totalPages/iu);
    expect(list).toContain("Older");
    expect(list).toContain("Newer");
  });

  it("stops polling once the operator has walked back into the log", () => {
    const page = readAdminFile("src/routes/FeedbackOutboxPage.tsx");

    // Refreshing an older page either moves it under the reader or spends a
    // request proving a finished slice has not changed.
    expect(page).toContain("const atNewest = cursor === undefined");
    expect(page).toContain(
      "...(atNewest\n          ? { refetchInterval: OUTBOX_HISTORY_POLL_INTERVAL_MS }\n          : {})",
    );
    expect(page).toContain("refetchOnWindowFocus: atNewest");
    // And the list stops claiming to be live when it is not.
    const list = readAdminFile(
      "src/components/admin/feedback/OutboxHistoryList.tsx",
    );
    expect(list).toContain("atNewest ? (\n          <JtsLiveIndicator");
    expect(list).toContain("Jump to newest");
  });

  it("restarts the walk whenever the filtered set itself changes", () => {
    const page = readAdminFile("src/routes/FeedbackOutboxPage.tsx");

    // A cursor is a position inside one filtered set. Carrying it across a
    // filter change asks the server to continue from a row that may not be in
    // the new set at all.
    const changeFilter = page.slice(
      page.indexOf("const changeFilter"),
      page.indexOf("const nextCursor"),
    );
    expect(changeFilter).toContain("setCursors([])");
  });
});

describe("narrowing the log", () => {
  it("offers the questions people ask a log, not two date pickers", () => {
    expect(outbox.OUTBOX_HISTORY_RANGES.map((range) => range.key)).toEqual([
      "hour",
      "today",
      "week",
      "all",
    ]);
    // «All» sends no bound at all rather than an ancient date.
    expect(outbox.outboxHistoryRangeFrom("all")).toBeUndefined();

    const toolbar = readAdminFile(
      "src/components/admin/feedback/OutboxHistoryToolbar.tsx",
    );
    expect(toolbar).not.toContain('type="date"');
  });

  it("measures a range against the operator's own clock, not the server's", () => {
    // Every age on this screen is measured on the server because an age is a
    // measurement. A range is a question, and «today» is a question about the
    // day the person asking is having.
    const now = new Date("2026-07-27T11:43:27.000Z");

    const hour = outbox.outboxHistoryRangeFrom("hour", now);
    expect(hour).toBe("2026-07-27T10:43:27.000Z");

    const today = outbox.outboxHistoryRangeFrom("today", now);
    const localMidnight = new Date(now);
    localMidnight.setHours(0, 0, 0, 0);
    expect(today).toBe(localMidnight.toISOString());

    expect(outbox.outboxHistoryRangeFrom("week", now)).toBe(
      "2026-07-20T11:43:27.000Z",
    );
  });

  it("filters by the same words the rows are badged with", () => {
    // A word must not mean one thing in the filter and another on the row it
    // selects, so the options are built from the badge vocabulary itself.
    for (const option of outbox.OUTBOX_HISTORY_STATUS_FILTERS) {
      if (option.key === "any") {
        continue;
      }
      expect(option.label).toBe(
        outbox.outboxHistoryStatusBadge(option.key).label,
      );
    }
    expect(outbox.OUTBOX_HISTORY_STATUS_FILTERS[0]?.key).toBe("any");
  });

  it("refuses a range or status the URL made up", () => {
    expect(outbox.isOutboxHistoryRangeKey("today")).toBe(true);
    expect(outbox.isOutboxHistoryRangeKey("fortnight")).toBe(false);
    expect(outbox.isOutboxHistoryRangeKey(null)).toBe(false);
    expect(outbox.isOutboxHistoryStatus("failed")).toBe(true);
    expect(outbox.isOutboxHistoryStatus("exploded")).toBe(false);
  });

  it("says «nothing matches» rather than «nothing exists» when a filter is on", () => {
    const list = readAdminFile(
      "src/components/admin/feedback/OutboxHistoryList.tsx",
    );
    // Telling an operator the table is empty when their filter is what is
    // empty sends them looking for a bug.
    expect(list).toContain("total === 0");
    expect(list).toContain("matches this range and status");
  });
});

describe("the opened row, after the rebrand", () => {
  it("shows the message itself, which is the one thing the participant saw", () => {
    const details = readAdminFile(
      "src/components/admin/feedback/OutboxMessageDetails.tsx",
    );

    expect(details).toContain("message.body");
    expect(details).toContain("whitespace-pre-wrap");
    // And it names the person and the event, which the pane never did.
    expect(details).toContain("message.respondentDisplayName");
    expect(details).toContain("message.phoneAtLaunch");
    expect(details).toContain("message.eventTitle");
  });

  it("draws the gaps between the steps, not six absolute times", () => {
    const timeline = deliveryTimeline({
      status: "sent",
      createdAt: "2026-07-27T11:41:00.000Z",
      updatedAt: "2026-07-27T11:41:00.400Z",
      sentAt: "2026-07-27T11:41:00.400Z",
      deliveredAt: "2026-07-27T11:41:01.600Z",
      readAt: "2026-07-27T11:43:10.600Z",
      playedAt: null,
    });

    expect(timeline.map((step) => step.label)).toEqual([
      "Written",
      "Sent",
      "Delivered",
      "Read",
    ]);
    // The first step has no previous, so it claims no gap.
    expect(timeline[0]?.sincePrevious).toBeNull();
    expect(timeline[1]?.sincePrevious).toBe("+400ms");
    expect(timeline[2]?.sincePrevious).toBe("+1.2s");
    expect(timeline[3]?.sincePrevious).toBe("+2m 09s");
  });

  it("keeps sub-second resolution, because that is the scale delivery lives on", () => {
    // `formatWaiting` would print all three of a healthy delivery's gaps as
    // «0s» — three zeros in a column whose only job is to show nothing was slow.
    expect(outbox.formatDelta(0)).toBe("+0ms");
    expect(outbox.formatDelta(412)).toBe("+412ms");
    expect(outbox.formatDelta(1_400)).toBe("+1.4s");
    expect(outbox.formatDelta(147_000)).toBe("+2m 27s");
    // A clock that went backwards is not a negative gap.
    expect(outbox.formatDelta(-50)).toBe("+0ms");
  });

  it("omits steps that did not happen instead of printing em dashes", () => {
    const timeline = deliveryTimeline({
      status: "pending",
      createdAt: "2026-07-27T11:41:00.000Z",
      updatedAt: "2026-07-27T11:41:00.000Z",
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      playedAt: null,
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.label).toBe("Written");
  });

  it("names `updatedAt` only where it means something", () => {
    // A bridge-only `sending` row has no trustworthy provider-boundary time;
    // on a terminal row `updatedAt` is the moment the row stopped. Everywhere
    // else it changes for reasons the screen has no word for.
    const bridge = deliveryTimeline({
      status: "sending",
      createdAt: "2026-07-27T11:41:00.000Z",
      updatedAt: "2026-07-27T11:41:02.000Z",
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      playedAt: null,
    });
    expect(bridge.map((step) => step.label)).toEqual(["Written"]);

    const failed = deliveryTimeline({
      status: "failed",
      createdAt: "2026-07-27T11:41:00.000Z",
      updatedAt: "2026-07-27T11:41:09.000Z",
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      playedAt: null,
    });
    expect(failed.at(-1)).toMatchObject({ label: "Failed", terminal: true });

    const sent = deliveryTimeline({
      status: "sent",
      createdAt: "2026-07-27T11:41:00.000Z",
      updatedAt: "2026-07-27T11:41:30.000Z",
      sentAt: "2026-07-27T11:41:00.400Z",
      deliveredAt: null,
      readAt: null,
      playedAt: null,
    });
    expect(sent.map((step) => step.label)).toEqual(["Written", "Sent"]);
  });

  it("draws the durable attempt boundary and ambiguous stop without a relay step", () => {
    const timeline = outbox.outboundDeliveryTimeline({
      message: {
        status: "ambiguous",
        createdAt: "2026-07-27T11:41:00.000Z",
        updatedAt: "2026-07-27T11:41:09.000Z",
        sentAt: null,
        deliveredAt: null,
        readAt: null,
        playedAt: null,
      },
      dispatch: dispatch({
        state: "ambiguous",
        sendStartedAt: "2026-07-27T11:41:02.000Z",
        attemptCount: 1,
      }),
    });

    expect(timeline.map((step) => step.label)).toEqual([
      "Written",
      "Provider attempt started",
      "Needs reconciliation",
    ]);
    expect(timeline.at(-1)?.terminal).toBe(true);
  });

  it("orders by the instants themselves, never by how they were assembled", () => {
    // A row that failed after a provider call has an `updatedAt` later than
    // its `sentAt`; printing them the other way round would invent a negative
    // gap out of correct data.
    const timeline = deliveryTimeline({
      status: "failed",
      createdAt: "2026-07-27T11:41:00.000Z",
      updatedAt: "2026-07-27T11:41:05.000Z",
      sentAt: "2026-07-27T11:41:01.000Z",
      deliveredAt: null,
      readAt: null,
      playedAt: null,
    });

    expect(timeline.map((step) => step.label)).toEqual([
      "Written",
      "Sent",
      "Failed",
    ]);
    expect(
      timeline.every((step) => !step.sincePrevious?.startsWith("+-")),
    ).toBe(true);
  });

  it("repeats the provider's reading only where the timeline cannot draw it", () => {
    // Four of the six delivery statuses are exactly the steps the timeline
    // draws with their times attached; repeating them as a word without a time
    // is strictly less information in more space.
    for (const status of ["sent", "delivered", "read", "played"] as const) {
      expect(outbox.outboxProviderReadingBadge(status)).toBeNull();
    }
    expect(outbox.outboxProviderReadingBadge(null)).toBeNull();
    // The two that survive are the two with no timestamp of their own.
    expect(outbox.outboxProviderReadingBadge("error")?.tone).toBe("danger");
    expect(outbox.outboxProviderReadingBadge("pending")?.label).toContain(
      "not confirmed",
    );
  });

  it("stops printing the paragraph that is true on every healthy row", () => {
    const details = readAdminFile(
      "src/components/admin/feedback/OutboxMessageDetails.tsx",
    );

    // Generic healthy-state copy taught operators to skip the paragraph that
    // matters on the rows where the campaign is not running.
    expect(details).not.toContain(
      "the relay leases this row as soon as it can",
    );
    expect(details).toContain("parked ? (");
    expect(details).toContain("message.dispatch");
    expect(details).not.toContain("Why there is no retry history");
    expect(details).not.toContain("message.job");
  });

  it("groups provider ids by the purpose they share — being pasted elsewhere", () => {
    const details = readAdminFile(
      "src/components/admin/feedback/OutboxMessageDetails.tsx",
    );

    expect(details).toContain('title="Identifiers"');
    expect(details).not.toContain('label="Job"');
    const identifiersAt = details.indexOf('title="Identifiers"');
    expect(identifiersAt).toBeGreaterThan(
      details.indexOf('title="Why this was sent"'),
    );
    expect(identifiersAt).toBeGreaterThan(
      details.indexOf('title="Dispatch activity"'),
    );
  });
});

describe("fitting a laptop screen", () => {
  it("splits into two columns at `lg`, with the detail pane the wide one", () => {
    const page = readAdminFile("src/routes/FeedbackOutboxPage.tsx");

    // `2xl` is 1536px. A 1440px laptop never reached it, so the pane meant to
    // sit beside the list spent its life underneath it.
    expect(page).not.toContain("2xl:grid-cols");
    expect(page).toContain("lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]");
  });

  it("gives the panes the viewport instead of growing the document", () => {
    const page = readAdminFile("src/routes/FeedbackOutboxPage.tsx");
    const shell = readAdminFile("src/components/admin/AdminShell.tsx");

    // Two panes at `max-h-[78vh]` plus a header, a toggle and three stat cards
    // came to more than a laptop viewport, so the whole layout scrolled to
    // reach controls that were meant to stay in view.
    for (const file of [
      "src/components/admin/feedback/OutboxQueueList.tsx",
      "src/components/admin/feedback/OutboxHistoryList.tsx",
      "src/components/admin/feedback/OutboxMessageDetails.tsx",
    ]) {
      expect(readAdminFile(file)).not.toContain("max-h-[78vh]");
    }
    expect(page).toContain("flex h-full min-h-0 flex-col");
    expect(page).toContain("grid min-h-0 flex-1");
    // Each pane owns its own scrolling, which is the price of taking the
    // viewport.
    expect(
      readAdminFile("src/components/admin/feedback/OutboxHistoryList.tsx"),
    ).toContain("min-h-0 flex-1 overflow-y-auto");
    expect(shell).toContain('"/admin/outbound"');
  });

  it("spends no card height on three single-digit numbers", () => {
    const page = readAdminFile("src/routes/FeedbackOutboxPage.tsx");

    // The height three stat cards took came straight out of the two panes
    // doing the work.
    expect(page).not.toContain("<JtsStat");
    expect(page).toContain("QueueFigure");
  });
});

describe("the load constraint the screen exists under", () => {
  it("reads detailed durable state only for the row an operator opened", () => {
    const page = readAdminFile("src/routes/FeedbackOutboxPage.tsx");

    // Both endpoints read PostgreSQL, and the heavier per-row detail remains
    // gated on a selection.
    expect(page).toContain("useListFeedbackOutboxQueue");
    expect(page).toContain("useGetFeedbackOutboxMessage");
    expect(page).toContain("enabled: selectedId !== null");
    expect(page).toContain('from "../api/generated/feedback-outbox"');
    expect(page).toContain("dispatch record");
    expect(page).not.toContain("delivery job");
    expect(page).not.toContain("ofetch");
  });

  it("keeps every backend page read free of ephemeral queue inspection", () => {
    const service = readFileSync(
      fileURLToPath(
        new URL(
          "../../backend/src/modules/post-event-feedback/outbox/queue-view.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(service).not.toContain("getJob");
    expect(service).not.toContain("inspectFeedbackDeliverJob");

    const listBody = service.slice(
      service.indexOf("async listQueue("),
      service.indexOf("async getMessageDelivery("),
    );

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

    expect(details).toContain("activity.state");
    expect(details).toContain("activity.timing");
    expect(details).toContain("message.dispatch");
    expect(details).not.toContain("message.job");
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
      "src/components/admin/feedback/CopyableId.tsx",
      "src/components/admin/feedback/ProviderMark.tsx",
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
