import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * WP9 — the feedback conversations inbox.
 *
 * The screen's rules live in `src/features/feedback/*`, which is React-free and
 * therefore unit-testable here. As in `theme-switch.spec.ts`, the real modules
 * are loaded through a computed URL so they stay out of this node project's
 * type program while vitest still exercises the shipped implementation.
 */

type GoalStatus = "pending" | "asked" | "answered" | "skipped";

interface TestConversation {
  id: string;
  respondentDisplayName: string | null;
  phoneAtLaunch: string;
  createdAt: string;
  lastMessageAt: string | null;
  needsAttention: boolean;
  lifecycle: { state: "open" | "closed"; reason: string | null };
  control: { mode: "bot" | "human" };
  goals: { status: GoalStatus }[];
}

interface LabelsModule {
  participantLabel: (displayName: string | null) => string;
  isUnresolvedParticipant: (displayName: string | null) => boolean;
  UNKNOWN_PARTICIPANT_LABEL: string;
  deliveryBadge: (delivery: unknown) => {
    label: string;
    tone: string;
    placement: "inline" | "badge";
    icon: string;
    detail?: string;
  } | null;
  isAwaitingDelivery: (delivery: unknown) => boolean;
  awaitingDeliveryReason: (delivery: unknown) => string | null;
  lifecycleBadge: (lifecycle: {
    state: "open" | "closed";
    reason: string | null;
  }) => { label: string; tone: string };
  noteOriginLabel: (origin: "conversation" | "staff") => string;
  staffOriginBadge: (
    origin: "conversation" | "staff",
  ) => { key: string; label: string; tone: string } | null;
  messageAttentionCategoryLabel: (category: string) => string;
  messageAttentionActionLabel: (action: string) => string;
  attentionReasonLabel: (kind: string) => string;
  questionLabel: (key: string) => string;
  QUESTION_KEYS: readonly string[];
}

interface ConversationViewModule {
  goalProgress: (goals: { status: GoalStatus }[]) => {
    answered: number;
    skipped: number;
    outstanding: number;
    settled: number;
    total: number;
  };
  sortConversationsForInbox: (rows: TestConversation[]) => TestConversation[];
  groupConversations: (
    rows: TestConversation[],
  ) => { key: string; title: string; conversations: TestConversation[] }[];
  CONVERSATION_GROUP_TITLES: Record<string, string>;
  resolveSelectedConversationId: (
    visible: { id: string }[],
    requested: string | null,
    previousSelected?: string | null,
  ) => string | null;
  hasExplicitConversationSelection: (
    requested: string | null,
    selected: string | null,
  ) => boolean;
  conversationReplyIndicator: (conversation: {
    lifecycle: { state: "open" | "closed" };
    control: { mode: "bot" | "human" };
    automation: { state: "idle" | "scheduled" | "running" | "parked" };
    awaitingHuman: boolean;
  }) => "bot_replying" | "awaiting_staff" | null;
  conversationBadges: (
    conversation: TestConversation,
  ) => { key: string; label: string; tone: string; emphasis?: string }[];
  conversationRowBadges: (
    conversation: TestConversation,
    group: "attention" | "open" | "closed",
  ) => { key: string; label: string; tone: string; emphasis?: string }[];
  closedConversationLine: (conversation: TestConversation) => string | null;
  transcriptMessageAnchorId: (messageId: string) => string;
  sameTranscriptMinute: (aIso: string, bIso: string) => boolean;
  formatExactTimestamp: (iso: string) => string;
}

interface PollingModule {
  conversationPollInterval: (
    conversation: { lifecycle: { state: "open" | "closed" } } | undefined,
  ) => number | false;
  CONVERSATION_POLL_INTERVAL_MS: number;
  CONVERSATION_LIST_POLL_INTERVAL_MS: number;
}

interface ExtractionStatusModule {
  readingStatusLines: (
    input: {
      unreadParticipantMessages: number;
      lastRunAt: string | null;
      model: string | null;
      automation: {
        state: "idle" | "scheduled" | "running" | "parked";
        nextActionAt: string | null;
        revision: number;
        claimExpiresAt: string | null;
      };
      constraint:
        | "none"
        | "conversation_closed"
        | "human_control"
        | "campaign_paused"
        | "campaign_closed";
    },
    now?: Date,
  ) => {
    unread: string;
    schedule: string | null;
    model: string | null;
    attention: "none" | "pending" | "danger";
  };
}

interface TestAnswer {
  questionKey: string;
  valueInt: number | null;
  subjectParticipantId: string | null;
  correction: { at: string; by: string } | null;
}

interface AnswerCorrectionsModule {
  FEEDBACK_SCORE_CHOICES: readonly number[];
  canCorrectAnswerValue: (answer: TestAnswer) => boolean;
  canWithdrawAnswer: (answer: TestAnswer) => boolean;
  correctionSummary: (answer: TestAnswer) => string | null;
  withdrawalDescription: (
    questionLabel: string,
    subjectLabel: string,
  ) => string;
}

interface DirectedAnswersModule {
  DIRECTED_QUESTION_KEYS: readonly string[];
  isDirectedQuestion: (key: string) => boolean;
  directedQuestionTone: (key: string) => string;
  contradictedQuestionKeys: (key: string) => readonly string[];
  answerCandidateChoices: (
    candidates: readonly { participantId: string; displayName: string }[],
    answers: readonly {
      questionKey: string;
      subjectParticipantId: string | null;
    }[],
    questionKey: string,
  ) => readonly {
    participantId: string;
    displayName: string;
    movesFrom: readonly string[];
  }[];
  recordAnswerDescription: (input: {
    questionLabel: string;
    subjectLabel: string;
    movesFromLabels: readonly string[];
  }) => string;
}

interface StaffCloseModule {
  STAFF_CLOSE_REASONS: readonly string[];
  staffCloseReasonLabel: (reason: string) => string;
  staffCloseSummary: (staffClose: {
    reason: string;
    note: string | null;
  }) => string;
}

interface TestSummaryStatus {
  status: "none" | "pending" | "ready" | "failed";
  isPartial: boolean;
  requestedAt: string | null;
  executionEpoch: number | null;
  claimExpiresAt: string | null;
}

interface CampaignSummaryModule {
  campaignSummaryStatusLabel: (
    summary: TestSummaryStatus,
    now?: Date,
  ) => string;
  campaignSummaryPendingPhase: (
    summary: Pick<
      TestSummaryStatus,
      "status" | "executionEpoch" | "claimExpiresAt"
    >,
    now?: Date,
  ) => "queued" | "generating" | "retrying" | null;
  campaignSummaryElapsedLabel: (
    requestedAt: string | null,
    now?: Date,
  ) => string | null;
  campaignSummaryPendingDetail: (
    phase: "queued" | "generating" | "retrying",
  ) => string;
  campaignSummaryActionLabel: (
    status: "none" | "pending" | "ready" | "failed",
  ) => "Generate" | "Refresh";
  campaignSummaryPartialWarning: (summary: {
    isPartial: boolean;
    openConversationCount: number | null;
  }) => string | null;
}

interface StaffMessageDraftModule {
  createStaffMessageDraft: (createId: () => string) => {
    readonly text: string;
    readonly clientMessageId: string;
  };
  editStaffMessageDraft: (
    current: { readonly text: string; readonly clientMessageId: string },
    text: string,
    createId: () => string,
  ) => { readonly text: string; readonly clientMessageId: string };
  settleStaffMessageDraft: (
    current: { readonly text: string; readonly clientMessageId: string },
    submittedClientMessageId: string,
    succeeded: boolean,
    createId: () => string,
  ) => { readonly text: string; readonly clientMessageId: string };
}

let labels: LabelsModule;
let view: ConversationViewModule;
let polling: PollingModule;
let extractionStatus: ExtractionStatusModule;
let answerCorrections: AnswerCorrectionsModule;
let directedAnswers: DirectedAnswersModule;
let staffClose: StaffCloseModule;
let campaignSummary: CampaignSummaryModule;
let staffMessageDraft: StaffMessageDraftModule;

async function loadFeatureModule<T>(relativePath: string): Promise<T> {
  const moduleUrl = new URL(`../${relativePath}`, import.meta.url).href;
  return (await import(moduleUrl)) as T;
}

beforeAll(async () => {
  labels = await loadFeatureModule<LabelsModule>(
    "src/features/feedback/labels.ts",
  );
  view = await loadFeatureModule<ConversationViewModule>(
    "src/features/feedback/conversationView.ts",
  );
  polling = await loadFeatureModule<PollingModule>(
    "src/features/feedback/polling.ts",
  );
  extractionStatus = await loadFeatureModule<ExtractionStatusModule>(
    "src/features/feedback/extractionStatus.ts",
  );
  answerCorrections = await loadFeatureModule<AnswerCorrectionsModule>(
    "src/features/feedback/answerCorrections.ts",
  );
  directedAnswers = await loadFeatureModule<DirectedAnswersModule>(
    "src/features/feedback/directedAnswers.ts",
  );
  staffClose = await loadFeatureModule<StaffCloseModule>(
    "src/features/feedback/staffClose.ts",
  );
  campaignSummary = await loadFeatureModule<CampaignSummaryModule>(
    "src/features/feedback/campaignSummary.ts",
  );
  staffMessageDraft = await loadFeatureModule<StaffMessageDraftModule>(
    "src/features/feedback/staffMessageDraft.ts",
  );
});

function conversation(
  overrides: Partial<TestConversation> & { id: string },
): TestConversation {
  return {
    respondentDisplayName: "Κώστας",
    phoneAtLaunch: "+306900000000",
    createdAt: "2026-07-20T10:00:00.000Z",
    lastMessageAt: "2026-07-20T10:00:00.000Z",
    needsAttention: false,
    lifecycle: { state: "open", reason: null },
    control: { mode: "bot" },
    goals: [],
    ...overrides,
  };
}

describe("D18 unknown-participant degradation", () => {
  it("renders the agreed Greek fallback for any unresolved id", () => {
    expect(labels.participantLabel(null)).toBe("άγνωστος συμμετέχων");
    expect(labels.participantLabel("")).toBe("άγνωστος συμμετέχων");
    expect(labels.participantLabel("   ")).toBe("άγνωστος συμμετέχων");
    expect(labels.UNKNOWN_PARTICIPANT_LABEL).toBe("άγνωστος συμμετέχων");
  });

  it("keeps a resolved name untouched and reports resolution separately", () => {
    expect(labels.participantLabel("Ρούλα")).toBe("Ρούλα");
    expect(labels.isUnresolvedParticipant("Ρούλα")).toBe(false);
    expect(labels.isUnresolvedParticipant(null)).toBe(true);
    expect(labels.isUnresolvedParticipant("  ")).toBe(true);
  });
});

describe("outbound delivery state", () => {
  it("has no badge for an inbound message with no outbox row", () => {
    expect(labels.deliveryBadge(null)).toBeNull();
  });

  it("lets the provider's delivery status outrank the outbox status", () => {
    const badge = labels.deliveryBadge({
      outboxId: "a",
      outboxStatus: "sent",
      deliveryStatus: "read",
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      playedAt: null,
    });

    expect(badge?.label).toBe("Read");
    expect(badge?.tone).toBe("success");
  });

  it("surfaces a failure from either side as a danger badge", () => {
    expect(
      labels.deliveryBadge({
        outboxId: "a",
        outboxStatus: "sent",
        deliveryStatus: "error",
      })?.tone,
    ).toBe("danger");

    expect(
      labels.deliveryBadge({
        outboxId: "a",
        outboxStatus: "failed",
        deliveryStatus: null,
      })?.tone,
    ).toBe("danger");
  });

  it("leaves the ordinary sent message unbadged", () => {
    // Handed to the transport with nothing reported back is how every outbound
    // message ends. Badging it put a chip under almost every bubble, which is
    // how a chip stops being read; the exceptions still carry one.
    expect(
      labels.deliveryBadge({
        outboxId: "a",
        outboxStatus: "sent",
        deliveryStatus: null,
      }),
    ).toBeNull();
    expect(
      labels.deliveryBadge({
        outboxId: "a",
        outboxStatus: "sending",
        deliveryStatus: null,
      })?.label,
    ).toBe("Sending");
  });

  it("reports a queued outbox row as queued, not as sent", () => {
    expect(
      labels.deliveryBadge({
        outboxId: "a",
        outboxStatus: "pending",
        deliveryStatus: null,
      })?.label,
    ).toBe("Queued");
  });

  // A recorded message and a received one looked identical while delivery sat
  // behind model calls for up to 147 seconds, so a reply nobody had seen read
  // like one already answered.
  it.each([["pending"], ["sending"], ["held"]])(
    "treats an outbox row in %s as not yet with the participant",
    (outboxStatus) => {
      const delivery = { outboxId: "a", outboxStatus, deliveryStatus: null };

      expect(labels.isAwaitingDelivery(delivery)).toBe(true);
      expect(labels.awaitingDeliveryReason(delivery)).toContain(
        "not seen by the participant",
      );
    },
  );

  it.each([
    ["sent", null],
    ["sent", "delivered"],
    ["sent", "read"],
    ["failed", null],
    ["cancelled", null],
    ["sent", "error"],
  ])(
    "stops waiting once %s / %s settles it",
    (outboxStatus, deliveryStatus) => {
      const delivery = { outboxId: "a", outboxStatus, deliveryStatus };

      expect(labels.isAwaitingDelivery(delivery)).toBe(false);
      expect(labels.awaitingDeliveryReason(delivery)).toBeNull();
    },
  );

  it("has nothing to say about an inbound message", () => {
    expect(labels.isAwaitingDelivery(null)).toBe(false);
    expect(labels.awaitingDeliveryReason(null)).toBeNull();
  });

  // Queued is the commonest state in a live campaign, so it was also the
  // commonest chip — a chip under most bubbles, plus a dimmed bubble, plus a
  // sentence underneath, for one fact. The ordinary spectrum now sits in the
  // meta line the message already has; only the two states that never reach
  // anybody keep a chip.
  it.each([
    ["pending", null, "queued"],
    ["sending", null, "sending"],
    ["held", null, "held"],
    ["sent", "delivered", "delivered"],
    ["sent", "read", "read"],
  ])(
    "keeps %s / %s in the meta line rather than under the bubble",
    (outboxStatus, deliveryStatus, icon) => {
      const status = labels.deliveryBadge({
        outboxId: "a",
        outboxStatus,
        deliveryStatus,
      });

      expect(status?.placement).toBe("inline");
      expect(status?.icon).toBe(icon);
    },
  );

  it.each([
    ["failed", null],
    ["sent", "error"],
    ["cancelled", null],
  ])("gives %s / %s a chip, because it never arrives", (o, d) => {
    expect(
      labels.deliveryBadge({
        outboxId: "a",
        outboxStatus: o,
        deliveryStatus: d,
      })?.placement,
    ).toBe("badge");
  });

  // The point of the inline line, in three words. The full sentence survives as
  // its title; this is what an operator reads without hovering anything.
  it("says in the line itself that a queued message has not been sent", () => {
    expect(
      labels.deliveryBadge({
        outboxId: "a",
        outboxStatus: "pending",
        deliveryStatus: null,
      })?.detail,
    ).toBe("not sent yet");
  });

  // The line must not claim the send is being held to see whether the
  // participant writes again. `superseded_by_newer_testimony` is checked before
  // the outbox row is written and never after it, so a follow-up does not
  // withdraw a queued reply.
  it("never promises that a follow-up would stop the send", () => {
    const reason = labels.awaitingDeliveryReason({
      outboxId: "a",
      outboxStatus: "pending",
      deliveryStatus: null,
    });

    expect(reason).not.toMatch(/follow.?up|confirm|reply|waiting for/iu);
  });
});

describe("lifecycle badges", () => {
  it("names the closing reason rather than just 'closed'", () => {
    expect(
      labels.lifecycleBadge({ state: "closed", reason: "stopped" }),
    ).toEqual(expect.objectContaining({ label: "Stopped", tone: "danger" }));
    expect(
      labels.lifecycleBadge({ state: "closed", reason: "completed" }),
    ).toEqual(expect.objectContaining({ label: "Completed", tone: "success" }));
  });

  it("gives every tone its own pale pairing, tinted and solid", () => {
    const badges = readSource(
      "src/components/admin/feedback/FeedbackBadges.tsx",
    );

    // The whole point of leaving HeroUI's `Chip` behind: it has no `info`
    // slot, so slate statuses fell back to the same grey as `neutral` and
    // «Open» was indistinguishable from «Cancelled» in a column of rows.
    for (const [tone, fill] of [
      ["neutral", "bg-surface-sunken"],
      ["info", "bg-info-soft"],
      ["success", "bg-success-soft"],
      ["warning", "bg-warning-soft"],
      ["danger", "bg-danger-soft"],
      ["accent", "bg-copper-soft"],
    ]) {
      expect(badges).toMatch(new RegExp(`${tone}: "[^"]*${fill}[^"]*"`, "u"));
    }
    expect(badges).toContain("STRONG_TONE_STYLES");
  });

  it("keeps every status hairline in the token bridge", () => {
    const bridge = readFileSync(
      fileURLToPath(new URL("../src/styles/globals.css", import.meta.url)),
      "utf8",
    );

    // HeroUI models each status as fill + soft fill + text and stops there, so
    // `border-warning-border` emitted no rule at all until these existed.
    for (const status of ["success", "warning", "danger", "info"]) {
      expect(bridge).toContain(
        `--color-${status}-border: var(--jts-color-${status}-border);`,
      );
    }
  });
});

describe("goal progress", () => {
  it("counts skipped goals as settled, matching the questionnaire contract", () => {
    const progress = view.goalProgress([
      { status: "answered" },
      { status: "skipped" },
      { status: "asked" },
      { status: "pending" },
    ]);

    expect(progress).toEqual({
      answered: 1,
      skipped: 1,
      outstanding: 2,
      settled: 2,
      total: 4,
    });
  });

  it("holds at zero before the goals exist", () => {
    expect(view.goalProgress([])).toEqual({
      answered: 0,
      skipped: 0,
      outstanding: 0,
      settled: 0,
      total: 0,
    });
  });

  it("publishes no percentage now that no reader draws a bar", () => {
    // The inbox row states the fraction once, in words a screen reader can
    // read out of the row's name. A second, rounded encoding of the same
    // number had exactly one consumer and it is gone.
    expect(view.goalProgress([{ status: "answered" }])).not.toHaveProperty(
      "percent",
    );

    const list = readSource(
      "src/components/admin/feedback/ConversationList.tsx",
    );
    expect(list).toContain("progress.settled");
    expect(list).not.toContain("style={{ width:");
  });
});

describe("inbox ordering and grouping", () => {
  it("puts conversations needing attention above newer quiet ones", () => {
    const sorted = view.sortConversationsForInbox([
      conversation({ id: "quiet", lastMessageAt: "2026-07-20T12:00:00.000Z" }),
      conversation({
        id: "attention",
        needsAttention: true,
        lastMessageAt: "2026-07-20T09:00:00.000Z",
      }),
    ]);

    expect(sorted.map((row) => row.id)).toStrictEqual(["attention", "quiet"]);
  });

  it("orders the rest by most recent activity", () => {
    const sorted = view.sortConversationsForInbox([
      conversation({ id: "older", lastMessageAt: "2026-07-20T09:00:00.000Z" }),
      conversation({ id: "newer", lastMessageAt: "2026-07-20T12:00:00.000Z" }),
    ]);

    expect(sorted.map((row) => row.id)).toStrictEqual(["newer", "older"]);
  });

  it("drops empty buckets instead of rendering a heading over nothing", () => {
    const groups = view.groupConversations([
      conversation({ id: "open" }),
      conversation({
        id: "closed",
        lifecycle: { state: "closed", reason: "completed" },
      }),
    ]);

    expect(groups.map((group) => group.key)).toStrictEqual(["open", "closed"]);
  });

  it("takes every heading from the one title table the rows are measured against", () => {
    const groups = view.groupConversations([
      conversation({ id: "attention", needsAttention: true }),
      conversation({ id: "open" }),
      conversation({
        id: "closed",
        lifecycle: { state: "closed", reason: null },
      }),
    ]);

    expect(groups.map((group) => group.title)).toStrictEqual([
      view.CONVERSATION_GROUP_TITLES.attention,
      view.CONVERSATION_GROUP_TITLES.open,
      view.CONVERSATION_GROUP_TITLES.closed,
    ]);
    expect(groups.map((group) => group.title)).toStrictEqual([
      "Needs attention",
      "Open",
      "Closed",
    ]);
  });

  it("labels human control and attention in text, not by colour alone", () => {
    const badges = view.conversationBadges(
      conversation({
        id: "a",
        needsAttention: true,
        control: { mode: "human" },
      }),
    );

    expect(badges.map((badge) => badge.label)).toStrictEqual([
      "Open",
      "Human control",
      "Needs attention",
    ]);
  });
});

describe("a row never repeats its own heading", () => {
  it("drops «Needs attention» from the rows filed under it", () => {
    const badges = view.conversationRowBadges(
      conversation({ id: "a", needsAttention: true }),
      "attention",
    );

    expect(badges.some((badge) => badge.key === "attention")).toBe(false);
  });

  it("chips only the exceptional lifecycle under NEEDS ATTENTION", () => {
    // Both need a human; only one can still be replied to. The exception —
    // «Stopped», nobody can answer any more — keeps the chip; an ordinarily
    // open attention row states the normal case by absence.
    const open = view.conversationRowBadges(
      conversation({ id: "a", needsAttention: true }),
      "attention",
    );
    const stopped = view.conversationRowBadges(
      conversation({
        id: "b",
        needsAttention: true,
        lifecycle: { state: "closed", reason: "stopped" },
      }),
      "attention",
    );

    expect(open).toStrictEqual([]);
    expect(stopped.map((badge) => badge.label)).toStrictEqual(["Stopped"]);
  });

  it("leaves an ordinary open conversation with no chips at all", () => {
    expect(
      view.conversationRowBadges(conversation({ id: "a" }), "open"),
    ).toStrictEqual([]);
  });

  it("chips only the newsworthy closing reason under CLOSED", () => {
    // «Completed» is the ordinary end of a closed thread — a run of green
    // chips down the archive said nothing. «Stopped» is the exception that
    // still earns one.
    const completed = view.conversationRowBadges(
      conversation({
        id: "a",
        lifecycle: { state: "closed", reason: "completed" },
      }),
      "closed",
    );
    const stopped = view.conversationRowBadges(
      conversation({
        id: "b",
        lifecycle: { state: "closed", reason: "stopped" },
      }),
      "closed",
    );
    const unexplained = view.conversationRowBadges(
      conversation({ id: "c", lifecycle: { state: "closed", reason: null } }),
      "closed",
    );

    expect(completed).toStrictEqual([]);
    expect(stopped.map((badge) => badge.label)).toStrictEqual(["Stopped"]);
    expect(unexplained).toStrictEqual([]);
  });

  it("still names «Completed» where it is news — outside its own group", () => {
    const badges = view.conversationRowBadges(
      conversation({
        id: "a",
        needsAttention: true,
        lifecycle: { state: "closed", reason: "completed" },
      }),
      "attention",
    );

    expect(badges.map((badge) => badge.label)).toStrictEqual(["Completed"]);
  });

  it("never drops human control, which no heading states", () => {
    for (const group of ["attention", "open", "closed"] as const) {
      const badges = view.conversationRowBadges(
        conversation({
          id: "a",
          needsAttention: group === "attention",
          control: { mode: "human" },
          ...(group === "closed"
            ? { lifecycle: { state: "closed" as const, reason: null } }
            : {}),
        }),
        group,
      );

      expect(badges.map((badge) => badge.key)).toContain("control");
    }
  });

  it("keeps the full badge set as the row filter's starting point", () => {
    const full = view.conversationBadges(
      conversation({ id: "a", needsAttention: true }),
    );

    expect(full.map((badge) => badge.label)).toStrictEqual([
      "Open",
      "Needs attention",
    ]);
  });

  it("wires the rows to the badge filter and the header to the closed line", () => {
    expect(
      readSource("src/components/admin/feedback/ConversationList.tsx"),
    ).toContain("conversationRowBadges(");

    // The transcript header renders no badge row (density pass, 2026-08-01):
    // attention is the strip with its reasons, who-writes is the composer or
    // the foot indicator, conversation actions sit opposite the contact, and
    // the one fact nothing else states — the named end of a closed thread —
    // is the quiet closed pill on the header's right.
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );
    expect(transcript).toContain("closedConversationLine(");
    expect(transcript).not.toContain("conversationBadges(");
  });

  it("names a closed thread's end in the header line, and only a closed one", () => {
    expect(
      view.closedConversationLine(
        conversation({ id: "a", lifecycle: { state: "open", reason: null } }),
      ),
    ).toBeNull();
    expect(
      view.closedConversationLine(
        conversation({
          id: "a",
          lifecycle: { state: "closed", reason: "completed" },
        }),
      ),
    ).toBe("Completed — no messages can be sent.");
    expect(
      view.closedConversationLine(
        conversation({
          id: "a",
          lifecycle: { state: "closed", reason: "stopped" },
        }),
      ),
    ).toBe("Stopped — no messages can be sent.");
    expect(
      view.closedConversationLine(
        conversation({
          id: "a",
          lifecycle: { state: "closed", reason: null },
        }),
      ),
    ).toBe("Closed — no messages can be sent.");
  });

  it("names real execution and handoff without guessing from capabilities", () => {
    const status = (
      overrides: Partial<{
        lifecycle: { state: "open" | "closed" };
        control: { mode: "bot" | "human" };
        automation: {
          state: "idle" | "scheduled" | "running" | "parked";
        };
        awaitingHuman: boolean;
      }> = {},
    ) =>
      view.conversationReplyIndicator({
        lifecycle: { state: "open" },
        control: { mode: "bot" },
        automation: { state: "idle" },
        awaitingHuman: false,
        ...overrides,
      });

    expect(status()).toBeNull();
    expect(status({ automation: { state: "scheduled" } })).toBeNull();
    expect(status({ automation: { state: "parked" } })).toBeNull();
    expect(status({ automation: { state: "running" } })).toBe("bot_replying");
    expect(
      status({ automation: { state: "running" }, awaitingHuman: true }),
    ).toBe("awaiting_staff");
    expect(
      status({
        control: { mode: "human" },
        automation: { state: "running" },
      }),
    ).toBeNull();
    expect(
      status({
        lifecycle: { state: "closed" },
        automation: { state: "running" },
        awaitingHuman: true,
      }),
    ).toBeNull();
  });
});

describe("transcript minute grouping", () => {
  it("groups messages that share actor context by their display minute", () => {
    expect(
      view.sameTranscriptMinute(
        "2026-07-20T10:15:02.000Z",
        "2026-07-20T10:15:58.000Z",
      ),
    ).toBe(true);
    expect(
      view.sameTranscriptMinute(
        "2026-07-20T10:15:59.000Z",
        "2026-07-20T10:16:00.000Z",
      ),
    ).toBe(false);
    // Same wall-minute on different days is not the same minute.
    expect(
      view.sameTranscriptMinute(
        "2026-07-20T10:15:00.000Z",
        "2026-07-21T10:15:00.000Z",
      ),
    ).toBe(false);
    // Garbage never groups — a broken timestamp keeps its meta line.
    expect(view.sameTranscriptMinute("not-a-date", "not-a-date")).toBe(false);
  });

  it("reveals a full date-and-seconds timestamp for a collapsed message", () => {
    const exact = view.formatExactTimestamp("2026-07-20T10:15:42.000Z");

    // Locale-rendered, so assert the parts rather than one exact string.
    expect(exact).toContain("2026");
    expect(exact).toContain("Jul");
    expect(exact).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(view.formatExactTimestamp("not-a-date")).toBe("—");
  });
});

describe("needs-attention emphasis", () => {
  it("marks only the attention badge as strong", () => {
    const badges = view.conversationBadges(
      conversation({
        id: "a",
        needsAttention: true,
        control: { mode: "human" },
      }),
    );

    expect(
      badges.map((badge) => [badge.key, badge.emphasis ?? "normal"]),
    ).toStrictEqual([
      ["lifecycle", "normal"],
      ["control", "normal"],
      ["attention", "strong"],
    ]);
  });

  it("keeps the attention badge on the warning tone", () => {
    const [attention] = view
      .conversationBadges(conversation({ id: "a", needsAttention: true }))
      .filter((badge) => badge.key === "attention");

    expect(attention).toMatchObject({
      label: "Needs attention",
      tone: "warning",
      emphasis: "strong",
    });
  });

  it("emits no attention badge when nothing needs a human", () => {
    const badges = view.conversationBadges(
      conversation({ id: "a", needsAttention: false }),
    );

    expect(badges.some((badge) => badge.key === "attention")).toBe(false);
  });

  it("renders the emphasis through the shared badge component", () => {
    const badges = readSource(
      "src/components/admin/feedback/FeedbackBadges.tsx",
    );

    // Guards against the emphasis being dropped back to the tinted table,
    // which would silently flatten it while every other assertion passed.
    expect(badges).toContain('badge.emphasis === "strong"');
    expect(badges).toContain("STRONG_TONE_STYLES[badge.tone]");
    expect(badges).toContain("TONE_STYLES[badge.tone]");
    // The solid pairing is the status fill on canvas, which is what makes it
    // AA-safe in both themes.
    expect(badges).toContain("bg-warning text-canvas");
  });

  it("shows the badge row on inbox rows; the transcript keeps it for delivery only", () => {
    expect(
      readSource("src/components/admin/feedback/ConversationList.tsx"),
    ).toContain("<FeedbackBadges");

    // The transcript's one remaining badge row is the per-message delivery
    // exception (held / cancelled); the header renders none.
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );
    expect(transcript).toContain("<FeedbackBadges");
    expect(transcript).toContain("badges={[delivery]}");
  });

  it("uses fixed, readable labels for per-message attention metadata", () => {
    // The banana is deliberate and stays — this screen is read by the two or
    // three people who run the dinners, not by participants, and it is the
    // owner's call how their own back office reads.
    expect(labels.messageAttentionCategoryLabel("sexual_misconduct")).toBe(
      "🍌 Sexual misconduct",
    );
    expect(labels.messageAttentionCategoryLabel("self_harm")).toBe("Self-harm");
    expect(labels.messageAttentionActionLabel("human_follow_up")).toBe(
      "Human follow-up",
    );
  });

  it("flags the cited message with chips, not a second warning fill", () => {
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );

    // The attention strip already owns warning-soft. A filled bubble of the
    // same tint made the cited message and the strip one continuous slab.
    expect(transcript).toContain("message.attention");
    expect(transcript).not.toContain(
      "rounded-bl-sm border border-warning-border bg-warning-soft text-ink",
    );
    expect(transcript).toContain("messageAttentionCategoryLabel(category)");
    expect(transcript).toContain("messageAttentionActionLabel(");
    expect(transcript).toContain("BellRing");
  });

  it("keeps the category and action chips on one line, at one height", () => {
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );

    // The icon belongs to the chip, not to a flex layer nested inside its
    // label: that layer gave the action chip its own baseline and its own
    // padding, so it sat a half-step off the categories beside it.
    expect(transcript).not.toMatch(/<Chip\.Label>\s*<span className="flex/u);
    expect(transcript).toContain(
      '<ActionIcon aria-hidden="true" className="size-3.5 shrink-0" />',
    );
    // Each list item is a flex container, so its chip is a flex item with no
    // inline baseline to sit on and no descender gap under it.
    expect(transcript).toContain('<li key={category} className="flex">');
    expect(transcript).toContain("flex flex-wrap items-center gap-1.5");
  });

  it("carries no theme branching: the tokens flip, the component does not", () => {
    for (const file of [
      "src/components/admin/feedback/FeedbackBadges.tsx",
      "src/features/feedback/labels.ts",
    ]) {
      expect(readSource(file)).not.toContain("dark:");
    }
  });
});

describe("attention reasons (why a conversation wants a person)", () => {
  it("says plainly what each kind of reason is", () => {
    // Situations that used to arrive looking identical. Every one is a sentence
    // about what happened, not an instruction.
    expect(labels.attentionReasonLabel("safety")).toBe(
      "A message raised a safety concern.",
    );
    expect(labels.attentionReasonLabel("handoff")).toBe(
      "The participant asked to speak to a person.",
    );
    expect(labels.attentionReasonLabel("unattributed_note")).toBe(
      "A note could not be attributed to anyone.",
    );
    expect(labels.attentionReasonLabel("answer_revision")).toBe(
      "An answer was revised after it had been recorded.",
    );
    expect(labels.attentionReasonLabel("hostile_to_bot")).toBe(
      "The participant was hostile to the bot.",
    );
  });

  it("has words for every reason the backend can raise", () => {
    // The list the backend enumerates, kept here on purpose: a kind with no
    // label renders the box with a blank line, which is the original defect with
    // extra steps. Τούλα Φωνητικομανού's voice notes hit `unreadable_message`
    // on every rehearsal run and had nothing to show for it.
    const kinds = [
      "safety",
      "handoff",
      "unattributed_note",
      "answer_revision",
      "hostile_to_bot",
      "unfinished_questionnaire",
      "extraction_failed",
      "unreadable_message",
      "transcript_mismatch",
      "transcript_full",
      "undelivered_message",
      "post_closure_message",
      "stopped_without_answers",
    ];

    for (const kind of kinds) {
      const label = labels.attentionReasonLabel(kind);
      expect(label, kind).toBeTypeOf("string");
      expect(label, kind).toMatch(/^[A-Z].*\.$/u);
    }
  });

  it("names what happened rather than telling the operator what to do", () => {
    // The reason box is not a task list. What to do is the operator's call once
    // they have read the message the reason links to.
    expect(labels.attentionReasonLabel("unreadable_message")).toBe(
      "Something arrived with no text to read — a voice note, or media.",
    );
    expect(labels.attentionReasonLabel("unfinished_questionnaire")).toBe(
      "The bot stopped asking before the questionnaire was finished.",
    );
    // One sentence for two causes, because a truncated copy and an edited
    // redelivery are the same job: go and read what actually arrived.
    expect(labels.attentionReasonLabel("transcript_mismatch")).toBe(
      "The transcript is not a faithful copy of a message that arrived.",
    );
    expect(labels.attentionReasonLabel("undelivered_message")).toBe(
      "A message the bot wrote never reached the participant.",
    );
  });

  it("anchors a message with one id both ends of the link share", () => {
    expect(view.transcriptMessageAnchorId("abc")).toBe(
      "transcript-message-abc",
    );
    // The anchor and the thing pointing at it must come from the same helper,
    // or the link silently scrolls nowhere.
    expect(
      readSource("src/components/admin/feedback/ConversationTranscript.tsx"),
    ).toContain("transcriptMessageAnchorId");
    expect(
      readSource("src/features/feedback/revealTranscriptMessage.ts"),
    ).toContain("transcriptMessageAnchorId");
  });

  it("reveals a cited message inside the transcript scroller, not the page", () => {
    const attention = readSource(
      "src/components/admin/feedback/ConversationAttention.tsx",
    );
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );
    const reveal = readSource(
      "src/features/feedback/revealTranscriptMessage.ts",
    );
    const styles = readSource("src/styles/globals.css");

    // scrollIntoView on the message walks document ancestors and yanks the
    // page — the same defect follow-bottom already forbids.
    expect(attention).not.toContain("scrollIntoView");
    expect(attention).toContain("revealTranscriptMessage");
    expect(transcript).toContain("data-transcript-pane");
    expect(transcript).toContain("data-transcript-scroller");
    expect(transcript).toContain("data-transcript-bubble");
    expect(reveal).toContain("data-transcript-scroller");
    // Wide: 16px air. Narrow: clear AdminShell's sticky `min-h-[4.5rem]` bar
    // (72px) plus the same air, or the cited message lands under the header.
    expect(reveal).toContain("PANE_TOP_INSET_WIDE_PX = 16");
    expect(reveal).toContain("PANE_TOP_INSET_NARROW_PX = 72 + PANE_TOP_INSET_WIDE_PX");
    expect(reveal).toContain('behavior: "smooth"');
    expect(reveal).toContain("jts-message-flash");
    expect(styles).toContain("@keyframes jts-message-flash");
    expect(styles).toContain("prefers-reduced-motion");
  });

  it("shows only unresolved reasons, and nothing at all when there are none", () => {
    const block = readSource(
      "src/components/admin/feedback/ConversationAttention.tsx",
    );

    expect(block).toContain("reason.resolvedAt === null");
    expect(block).toContain("unresolved.length === 0");
    expect(block).toContain("return null");
  });

  it("dismisses in one press: no dialog, no note", () => {
    const block = readSource(
      "src/components/admin/feedback/ConversationAttention.tsx",
    );

    // The product decision is that it goes away like an email. A confirmation
    // here is how the badge ends up never being cleared at all.
    expect(block).not.toContain("ConfirmAction");
    expect(block).not.toContain("Modal");
    expect(block).toContain("onDismiss(reason.id)");
  });

  it("keeps reason rows as dense as the collapsed disclosure", () => {
    const block = readSource(
      "src/components/admin/feedback/ConversationAttention.tsx",
    );

    // Same min-height for open rows and the accordion summary, with a compact
    // Dismiss — HeroUI has no xs size, so sm is shrunk by class. nowrap +
    // truncate keeps Dismiss on the reason's line on a narrow phone.
    expect(block).toContain('className="flex flex-col gap-0.5"');
    expect(block).toContain(
      "flex min-h-7 flex-nowrap items-center justify-between gap-x-3",
    );
    expect(block).toContain("min-w-0 truncate text-sm text-ink");
    expect(block).toContain("h-6 min-h-6 shrink-0 px-1.5 text-xs text-ink");
  });

  it("collapses more than two unresolved reasons into one disclosure", () => {
    const block = readSource(
      "src/components/admin/feedback/ConversationAttention.tsx",
    );

    // Two stay open: still a short list. Five open rows push the transcript
    // off the first screen, which is the defect the disclosure exists to end.
    expect(block).toContain("const COLLAPSE_AFTER = 2");
    expect(block).toContain("unresolved.length > COLLAPSE_AFTER");
    expect(block).toContain("Disclosure");
    expect(block).toContain("Disclosure.Indicator");
    expect(block).not.toContain("<details");
    expect(block).toContain("things need attention");
  });

  it("paints itself from the status tokens, in both themes", () => {
    const block = readSource(
      "src/components/admin/feedback/ConversationAttention.tsx",
    );

    expect(block).toContain("border-warning-border");
    expect(block).toContain("bg-warning-soft");
    // No literal colour, and no theme branching — the tokens flip, not the
    // component.
    expect(block).not.toContain("dark:");
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/iu);
  });
});

describe("extraction status (operator visibility)", () => {
  const idle = {
    unreadParticipantMessages: 0,
    lastRunAt: null as string | null,
    model: null as string | null,
    automation: {
      state: "idle" as const,
      nextActionAt: null as string | null,
      revision: 17,
      claimExpiresAt: null as string | null,
    },
    constraint: "none" as const,
  };

  it("names how far behind the reading is, in Greek", () => {
    expect(
      extractionStatus.readingStatusLines({
        ...idle,
        unreadParticipantMessages: 3,
      }).unread,
    ).toBe("3 μηνύματα δεν έχουν διαβαστεί ακόμα.");
    expect(
      extractionStatus.readingStatusLines({
        ...idle,
        unreadParticipantMessages: 1,
      }).unread,
    ).toBe("1 μήνυμα δεν έχει διαβαστεί ακόμα.");
  });

  it("reads scheduling from durable conversation work, not a retained job", () => {
    const lines = extractionStatus.readingStatusLines(
      {
        unreadParticipantMessages: 2,
        lastRunAt: null,
        model: null,
        automation: {
          state: "scheduled",
          nextActionAt: "2026-07-27T11:47:00.000Z",
          revision: 18,
          claimExpiresAt: null,
        },
        constraint: "none",
      },
      new Date("2026-07-27T11:00:00.000Z"),
    );

    expect(lines.schedule).toMatch(/^Επόμενη αυτόματη ενέργεια /);
    expect(lines.attention).toBe("pending");
  });

  it("shows the durable claim deadline without pretending the worker is alive", () => {
    const lines = extractionStatus.readingStatusLines(
      {
        unreadParticipantMessages: 1,
        lastRunAt: null,
        model: "openai/gpt-5-mini",
        automation: {
          state: "running",
          nextActionAt: null,
          revision: 19,
          claimExpiresAt: "2026-07-27T11:47:00.000Z",
        },
        constraint: "none",
      },
      new Date("2026-07-27T11:00:00.000Z"),
    );

    expect(lines.schedule).toContain("ενεργή ανάθεση έως");
    expect(lines.schedule).not.toContain("job");
  });

  it("treats parked work as the failure signal, with or without a retry time", () => {
    const base = {
      unreadParticipantMessages: 1,
      lastRunAt: null,
      model: "openai/gpt-5-mini",
      constraint: "none" as const,
    };

    const retrying = extractionStatus.readingStatusLines({
      ...base,
      automation: {
        state: "parked",
        nextActionAt: "2026-07-27T11:47:00.000Z",
        revision: 20,
        claimExpiresAt: null,
      },
    });
    const exhausted = extractionStatus.readingStatusLines({
      ...base,
      automation: {
        state: "parked",
        nextActionAt: null,
        revision: 20,
        claimExpiresAt: null,
      },
    });

    expect(retrying.schedule).toContain("επόμενος έλεγχος");
    expect(exhausted.schedule).toContain("περιμένει ανάκτηση");
    expect(retrying.attention).toBe("danger");
    expect(exhausted.attention).toBe("danger");
  });

  it("marks unread idle durable work as an invariant failure", () => {
    const lines = extractionStatus.readingStatusLines({
      unreadParticipantMessages: 1,
      lastRunAt: null,
      model: null,
      automation: {
        state: "idle",
        nextActionAt: null,
        revision: 20,
        claimExpiresAt: null,
      },
      constraint: "none",
    });

    expect(lines.schedule).toBe(
      "Δεν έχει προγραμματιστεί επόμενη αυτόματη ενέργεια.",
    );
    expect(lines.attention).toBe("danger");
  });

  it("explains current-state stops instead of reporting intentionally idle work as lost", () => {
    for (const [constraint, copy, attention] of [
      ["human_control", "χειρίζεται άνθρωπος", "pending"],
      ["campaign_paused", "καμπάνια είναι σε παύση", "pending"],
      ["conversation_closed", "συζήτηση έχει κλείσει", "danger"],
      ["campaign_closed", "καμπάνια έχει κλείσει", "danger"],
    ] as const) {
      const lines = extractionStatus.readingStatusLines({
        ...idle,
        unreadParticipantMessages: 1,
        constraint,
      });

      expect(lines.schedule).toContain(copy);
      expect(lines.attention).toBe(attention);
      expect(lines.schedule).not.toContain("Δεν έχει προγραμματιστεί");
    }
  });

  it("renders the status block as a polite live region without a spinner", () => {
    const details = readSource(
      "src/components/admin/feedback/ConversationDetails.tsx",
    );

    expect(details).toContain("readingStatusLines");
    expect(details).toContain('conversation.control.mode === "human"');
    expect(details).toContain('campaignStatus === "paused"');
    expect(details).toContain('role="status"');
    expect(details).toContain('aria-live="polite"');
    expect(details).not.toContain("animate-spin");
    expect(details).not.toContain("Loader");
  });

  it("lets a goal's answer stand in for its status badge", () => {
    const details = readSource(
      "src/components/admin/feedback/ConversationDetails.tsx",
    );

    // One row per goal, resolved against the answers by question key. A second
    // list below it made every answered goal state itself twice.
    expect(details).toContain("answer.questionKey === key");
    expect(details).toContain("goalStatusBadge(goal.status)");
    expect(details).not.toContain('title="Answers"');
  });

  it("reads the respondent's own record through the generated hook", () => {
    const details = readSource(
      "src/components/admin/feedback/ConversationDetails.tsx",
    );

    expect(details).toContain("useGetParticipant(");
    // D18: an unresolved id has no record to fetch, so the query never runs.
    expect(details).toContain("query: { enabled: !unresolved }");
  });

  it("pins reading status to the transcript foot, outside the message scroll", () => {
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );

    // «Why has that answer not appeared yet» is about these messages, but
    // scrolling older ones must not hide the answer — so it docks under the
    // scroller rather than riding inside it.
    expect(transcript).toContain("<ReadingStatus");
    expect(transcript).toContain("campaignStatus={campaignStatus}");
    const scrollOpen = transcript.indexOf("ref={scrollRef}");
    const footChrome = transcript.indexOf("shrink-0 border-t border-border");
    const reading = transcript.indexOf("<ReadingStatus");
    expect(scrollOpen).toBeGreaterThan(-1);
    expect(footChrome).toBeGreaterThan(scrollOpen);
    expect(reading).toBeGreaterThan(footChrome);
    const page = readSource("src/routes/FeedbackInboxPage.tsx");
    expect(page).toContain("campaignStatus={campaign?.status ?? null}");
    expect(page).not.toContain("ReadingStatus");
  });
});

describe("feedback mechanism map", () => {
  it("documents four queue contracts and the direct outbox dispatcher", () => {
    const page = readSource("src/routes/FeedbackMechanismPage.tsx");

    for (const contract of [
      "feedback.materialize.v1",
      "feedback.reconcile-conversation.v2",
      "feedback.summarize-campaign.v2",
      "feedback.maintenance.v2",
    ]) {
      expect(page).toContain(contract);
    }

    expect(page).toContain("dispatcher διαβάζει απευθείας το μόνιμο outbox");
    expect(page).toContain("ambiguous");
    expect(page).toContain("έξι πράγματα");
    expect(page).toContain(":::decision");
    expect(page).toContain(":::data");
    expect(page).toContain("flowchart LR");
    expect(page).toContain("specimenAttentionConversation");
    expect(page).toContain("ConversationAttention");
    expect(page).toContain("ReadingStatus");
    expect(page).not.toContain("liked");
    expect(page).not.toContain("sequenceDiagram");
    expect(page).not.toContain("feedback.extract.v1");
    expect(page).not.toContain("feedback.relay-outbox.v1");
    expect(page).not.toContain("feedback.deliver.v1");
    expect(page).not.toContain("feedback.sweep-reminders.v1");
  });
});

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

describe("staff-written notes", () => {
  it("badges a staff note and leaves extraction output unbadged", () => {
    // The default is the pane's own subject; only the exception is labelled,
    // and it is labelled in words rather than by tone alone.
    expect(labels.staffOriginBadge("conversation")).toBeNull();
    expect(labels.staffOriginBadge("staff")).toMatchObject({
      key: "origin",
      label: "Staff note",
      tone: "accent",
    });
    expect(labels.noteOriginLabel("conversation")).toBe("From conversation");
    expect(labels.noteOriginLabel("staff")).toBe("Staff note");
  });

  it("renders the origin wherever notes are read", () => {
    const details = readSource(
      "src/components/admin/feedback/ConversationDetails.tsx",
    );
    const results = readSource("src/routes/FeedbackResultsPage.tsx");

    expect(details).toContain("staffOriginBadge(note.origin)");
    // The Results tab is the other place a note is read, so it carries the
    // same fact as its own column rather than an easily missed inline hint.
    expect(results).toContain("staffOriginBadge(row.original.origin)");
    expect(results).toContain('header: "Source"');
  });

  it("writes the note through the generated hook and refreshes both readers", () => {
    const page = readSource("src/routes/FeedbackInboxPage.tsx");

    expect(page).toContain("useAddFeedbackConversationNote");
    expect(page).toContain("getListFeedbackConversationResultsQueryKey");
    expect(page).toContain("getListFeedbackCampaignResultsQueryKey");
  });

  it("offers only D16 candidates as the subject of a note", () => {
    const dialog = readSource(
      "src/components/admin/feedback/AddNoteAction.tsx",
    );

    // The same endpoint extraction resolves subjects with: present attendees
    // of the event, minus the respondent.
    expect(dialog).toContain("useListEventFeedbackCandidates");
    expect(dialog).toContain("respondentParticipantId");
  });
});

describe("operator corrections to recorded answers", () => {
  const score = {
    questionKey: "event_score",
    valueInt: 4,
    subjectParticipantId: null,
    correction: null,
  };
  const directed = {
    questionKey: "avoid",
    valueInt: null,
    subjectParticipantId: "p-nikos",
    correction: null,
  };

  it("offers a value edit only where the answer is a number", () => {
    // V2 has four independent 1–5 experience dimensions. The person-valued
    // questions have no magnitude, including the historical V1 `liked` key.
    for (const questionKey of [
      "event_score",
      "table_fit",
      "participation_ease",
      "conversation_balance",
    ]) {
      expect(
        answerCorrections.canCorrectAnswerValue({ ...score, questionKey }),
      ).toBe(true);
    }
    for (const questionKey of ["liked", "meet_again", "avoid"]) {
      expect(
        answerCorrections.canCorrectAnswerValue({ ...directed, questionKey }),
      ).toBe(false);
    }
    expect(answerCorrections.canCorrectAnswerValue(directed)).toBe(false);
    expect(answerCorrections.FEEDBACK_SCORE_CHOICES).toStrictEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("offers a withdrawal only where the answer is about a person", () => {
    // The wrong-person case: a claim about a third party who was never named
    // has no correct value, so the row should stop existing.
    expect(answerCorrections.canWithdrawAnswer(directed)).toBe(true);
    expect(answerCorrections.canWithdrawAnswer(score)).toBe(false);
  });

  it("says who decided a corrected value, and stays silent otherwise", () => {
    // `createdAt` stops meaning "when this value was decided" once a correction
    // lands, so a corrected number without this line has no author.
    expect(answerCorrections.correctionSummary(score)).toBeNull();
    const summary = answerCorrections.correctionSummary({
      ...score,
      valueInt: 2,
      correction: { at: "2026-07-27T10:00:00.000Z", by: "admin-1" },
    });
    expect(summary).toContain("Corrected by admin-1");
    expect(summary).toContain("2026");
  });

  it("names the person and the question before withdrawing an answer", () => {
    const description = answerCorrections.withdrawalDescription(
      "Avoid",
      "Νίκος",
    );

    expect(description).toContain("Avoid");
    expect(description).toContain("Νίκος");
    // It is a hard delete: only the audit log remembers the row afterwards.
    expect(description).toContain("cannot be undone");
  });

  it("puts both controls on the answer itself, without a capability gate", () => {
    const row = readSource(
      "src/components/admin/feedback/AnswerCorrection.tsx",
    );
    const details = readSource(
      "src/components/admin/feedback/ConversationDetails.tsx",
    );

    expect(details).toContain("<ScoreAnswer");
    expect(details).toContain("<AnswerPerson");
    // Recording what is true is not steering the conversation, so unlike every
    // control that could send a message these survive a closed thread — which
    // is the case they exist for, since nothing will ever re-read it.
    expect(row).not.toContain("capabilities");
    // A confirm for the destructive half, an inline edit for the other. No
    // workflow: nothing to assign and nothing to approve.
    expect(row).toContain("ConfirmAction");
    expect(row).toContain("Withdraw answer");
  });

  it("drives both operations through the generated hooks", () => {
    const page = readSource("src/routes/FeedbackInboxPage.tsx");

    expect(page).toContain("useCorrectFeedbackConversationAnswer");
    expect(page).toContain("useWithdrawFeedbackConversationAnswer");
    // Both readers of an answer are refreshed: this conversation's results and
    // the campaign-wide Results tab.
    expect(page).toContain("invalidateResults");
  });
});

describe("the people under a directed question", () => {
  const answers = [
    { questionKey: "liked", subjectParticipantId: "p-maria" },
    { questionKey: "meet_again", subjectParticipantId: "p-maria" },
    { questionKey: "avoid", subjectParticipantId: "p-nikos" },
    { questionKey: "event_score", subjectParticipantId: null },
  ];
  const candidates = [
    { participantId: "p-maria", displayName: "Μαρία" },
    { participantId: "p-nikos", displayName: "Νίκος" },
    { participantId: "p-kostas", displayName: "Κώστας" },
  ];

  it("groups exactly the three questions whose answer is a person", () => {
    expect(directedAnswers.DIRECTED_QUESTION_KEYS).toStrictEqual([
      "liked",
      "meet_again",
      "avoid",
    ]);
    // The score is a number, so it keeps its own row with the slider rather
    // than joining the groups of pills.
    expect(directedAnswers.isDirectedQuestion("event_score")).toBe(false);
    expect(directedAnswers.isDirectedQuestion("avoid")).toBe(true);
  });

  it("keeps no-rematch distinct without presenting it as a safety alert", () => {
    // Never the only signal — each group also keeps its heading and its glyph —
    // but «Μαρία» under Liked and under Avoid are opposite facts about the same
    // evening, and they must not look alike.
    expect(directedAnswers.directedQuestionTone("liked")).toBe("success");
    expect(directedAnswers.directedQuestionTone("meet_again")).toBe("info");
    expect(directedAnswers.directedQuestionTone("avoid")).toBe("warning");
  });

  it("knows which answers cannot both be true of one person", () => {
    // The same rule the backend performs the move with. Liking somebody and
    // wanting to see them again agree; wanting to avoid them contradicts both.
    expect(directedAnswers.contradictedQuestionKeys("avoid")).toStrictEqual([
      "liked",
      "meet_again",
    ]);
    expect(directedAnswers.contradictedQuestionKeys("liked")).toStrictEqual([
      "avoid",
    ]);
    expect(
      directedAnswers.contradictedQuestionKeys("meet_again"),
    ).toStrictEqual(["avoid"]);
  });

  it("offers everyone still addable, and says what choosing them costs", () => {
    const choices = directedAnswers.answerCandidateChoices(
      candidates,
      answers,
      "avoid",
    );

    // Νίκος is already under Avoid, so he is not offered again.
    expect(choices.map((choice) => choice.participantId)).toStrictEqual([
      "p-maria",
      "p-kostas",
    ]);
    // Μαρία is offered, but the option says she would leave both questions she
    // is under: an «avoid» clears them together, and naming one would
    // understate what confirming costs. Hiding her instead would leave an
    // operator hunting for a name that is at the event with nothing saying why
    // it is missing.
    expect(choices[0]?.movesFrom).toStrictEqual(["liked", "meet_again"]);
    expect(choices[1]?.movesFrom).toStrictEqual([]);
  });

  it("states the move before it happens, and stays quiet when nothing moves", () => {
    const plain = directedAnswers.recordAnswerDescription({
      questionLabel: "Liked",
      subjectLabel: "Κώστας",
      movesFromLabels: [],
    });
    expect(plain).toContain("Κώστας");
    // Recorded as an operator's own answer, never as the participant's words.
    expect(plain).toContain("staff-written");
    expect(plain).not.toContain("withdrawn");

    const moved = directedAnswers.recordAnswerDescription({
      questionLabel: "Avoid",
      subjectLabel: "Μαρία",
      movesFromLabels: ["Liked", "Meet again"],
    });
    expect(moved).toContain("«Liked» and «Meet again»");
    // Both go, so the sentence says so in the plural rather than naming one.
    expect(moved).toContain("those answers are withdrawn");
  });

  it("gives the score the whole width and the people their own line", () => {
    const row = readSource(
      "src/components/admin/feedback/AnswerCorrection.tsx",
    );
    const details = readSource(
      "src/components/admin/feedback/ConversationDetails.tsx",
    );

    // The slider is a line of its own under the question, not a third of a
    // right-hand column: five steps in that width moved a few pixels a point.
    expect(row).toContain('className="w-full"');
    expect(row).not.toContain('className="w-36"');
    // The people are pills on one wrapping line, tinted by their question.
    expect(row).toContain("PILL_TONE_STYLES");
    expect(details).toContain("flex flex-wrap items-start gap-1.5");
    // One glyph per group, so the tone is never carrying it alone.
    expect(details).toContain("DIRECTED_QUESTION_GLYPHS");
  });

  it("records a new answer through the generated hook, from the D16 list", () => {
    const dialog = readSource(
      "src/components/admin/feedback/AddAnswerAction.tsx",
    );
    const page = readSource("src/routes/FeedbackInboxPage.tsx");

    // The same endpoint extraction resolves subjects with: present attendees of
    // the event, minus the respondent.
    expect(dialog).toContain("useListEventFeedbackCandidates");
    // A confirmation, because recording an answer can move a person.
    expect(dialog).toContain("recordAnswerDescription");
    expect(page).toContain("useAddFeedbackConversationAnswer");
    // Both readers of an answer are refreshed, as for every other change.
    expect(page).toContain("invalidateResults");
  });

  it("marks an operator's own answer wherever it is read", () => {
    const row = readSource(
      "src/components/admin/feedback/AnswerCorrection.tsx",
    );

    // A month later nobody should have to guess whether the participant named
    // this person or somebody wrote it down after a phone call.
    expect(row).toContain('answer.origin === "staff"');
    expect(row).toContain("Recorded by staff");
  });
});

describe("questionnaire-version labels", () => {
  it("shows V2 in order and keeps the V1-only liked answer readable", () => {
    expect(labels.QUESTION_KEYS).toStrictEqual([
      "event_score",
      "table_fit",
      "participation_ease",
      "conversation_balance",
      "meet_again",
      "avoid",
      "liked",
    ]);
    expect(labels.questionLabel("conversation_balance")).toBe(
      "Conversation balance",
    );
    expect(labels.questionLabel("avoid")).toBe("No rematch");
    expect(labels.questionLabel("liked")).toBe("Liked (V1)");
  });
});

describe("staff close reason", () => {
  it("names every reason the backend accepts, and none it does not", () => {
    // The dialog's select and the summary line share this list, so inventing a
    // sixth reason here would either fail the close request or silently drop
    // from the UI.
    expect([...staffClose.STAFF_CLOSE_REASONS]).toStrictEqual([
      "abusive",
      "unresponsive",
      "handled_offline",
      "duplicate",
      "other",
    ]);
    expect(staffClose.staffCloseReasonLabel("handled_offline")).toBe(
      "Handled offline",
    );
  });

  it("says why a staff-cancelled conversation closed, with or without a note", () => {
    // Without this line every human close still reads as the bare «Cancelled»
    // the lifecycle enum can say, and a month later nobody can tell them apart.
    expect(
      staffClose.staffCloseSummary({ reason: "abusive", note: null }),
    ).toBe("Closed as abusive");
    expect(
      staffClose.staffCloseSummary({
        reason: "handled_offline",
        note: "Called them back",
      }),
    ).toBe("Closed as handled offline — Called them back");
  });

  it("asks for the reason inside the existing close confirm, not a new screen", () => {
    const details = readSource(
      "src/components/admin/feedback/ConversationDetails.tsx",
    );
    const page = readSource("src/routes/FeedbackInboxPage.tsx");
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );

    expect(details).toContain("STAFF_CLOSE_REASONS");
    expect(details).toContain("isConfirmDisabled");
    expect(details).toContain("onClose({");
    // The body travels with the generated close hook once OpenAPI regenerates.
    expect(page).toContain("data: input");
    expect(transcript).toContain("staffCloseSummary");
    expect(transcript).toContain("conversation.staffClose");
  });
});

describe("inbox toolbar and orientation", () => {
  it("keeps the campaign name before its actions on mobile, then lifts the actions on wider screens", () => {
    const page = readSource("src/components/admin/feedback/CampaignHeader.tsx");
    const back = page.indexOf("<JtsBackLink");
    const title = page.indexOf("<h1");
    const results = page.indexOf("<Link", title);
    const firstAction = page.indexOf("<ConfirmAction", results);

    // Mobile follows source order: leave, identify the campaign, then offer
    // navigation/results and mutations. A destructive action must not be the
    // first thing an operator meets before the campaign's own name.
    expect(back).toBeGreaterThan(-1);
    expect(back).toBeLessThan(title);
    expect(title).toBeLessThan(results);
    expect(results).toBeLessThan(firstAction);
    expect(page).toContain(
      '<JtsBackLink to="/admin/feedback">Back to campaigns</JtsBackLink>',
    );
    expect(page).not.toContain("ChevronLeft");

    // At `sm` only the visual grid changes: actions share the back-link row and
    // the title spans the row below. DOM/focus order remains the mobile order.
    expect(page).toContain(
      'className="grid gap-x-4 gap-y-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-y-2"',
    );
    expect(page).toContain("sm:col-span-2 sm:row-start-2");
    expect(page).toContain("sm:col-start-2 sm:row-start-1 sm:justify-self-end");
    expect(page).toContain('<span className="max-sm:hidden">Results</span>');
    expect(page.match(/collapseLabelAt="sm"/gu)).toHaveLength(3);
    expect(page).toContain(
      '<span className="sr-only">Simulated transport</span>',
    );
  });

  it("keeps venue context on one narrow line without redundant attention or simulator labels", () => {
    const page = readSource("src/components/admin/feedback/CampaignHeader.tsx");
    const context = page.slice(page.indexOf("export function CampaignContext"));
    const rootStart = context.indexOf("<div");
    const root = context.slice(rootStart, context.indexOf(">", rootStart));

    // Venue owns the shrinking width; only exceptional campaign/model state
    // may sit beside it, without growing a second row on phones.
    expect(rootStart).toBeGreaterThan(-1);
    expect(root).toContain("flex min-w-0 items-center");
    expect(root).toContain("overflow-hidden");
    expect(root).toContain("rounded-lg border border-border");
    expect(root).not.toContain("flex-wrap");
    expect(root).not.toContain("justify-between");
    expect(context).not.toContain("needsAttentionCount");
    expect(context).not.toContain("simulatorAvailable");
  });

  it("puts the summary card on the same gap as every other card", () => {
    const page = readSource("src/routes/FeedbackInboxPage.tsx");
    const surface = page.slice(page.indexOf("The app-wide page root"));
    expect(surface).not.toBe("");

    // One column, one rhythm: the nameplate, the summary, the two panes and the
    // detail strip are all one gap-4 apart, so nothing on this screen is a
    // different distance from its neighbour than anything else.
    expect(surface).toContain('<div className="flex flex-col gap-4">');
    expect(surface).toContain(
      '<div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-stretch gap-4 lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]">',
    );
    // The detail strip's classes, not its opening tag: below `lg` the strip is
    // part of the thread view and hides with it, so the class list now reaches
    // the element through a conditional rather than a literal attribute.
    expect(surface).toContain(
      "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 lg:col-span-2 xl:grid-cols-3",
    );

    // Exactly one gap is tighter, and it is the one binding the campaign's name
    // to the framed facts about it. Twice now a 24px gap has been left stranded
    // between two of these blocks — first above the frame, then below it — so
    // the page keeps no gap it cannot justify.
    expect(surface).toContain("flex flex-col gap-3");
    expect(surface).not.toContain('<div className="flex flex-col gap-2">');
  });

  it("keeps the populated inbox inside a narrow SPA viewport", () => {
    const page = readSource("src/routes/FeedbackInboxPage.tsx");

    // A route navigation can render the populated panes on the first layout.
    // CSS Grid's implicit auto track then adopts their min-content width unless
    // both the track and its direct items explicitly allow shrinking.
    expect(page).toContain("grid-cols-[minmax(0,1fr)] items-stretch gap-4");
    // List stays content-sized; the transcript fills the row beside it.
    expect(page).toContain("lg:self-start");
    // Two pane wrappers, and each now picks its classes per breakpoint so the
    // master/detail switch can hide one of them — four branches, every one of
    // which still has to carry the zero minimum.
    expect(page.match(/min-h-0 min-w-0/g)).toHaveLength(4);
    expect(page).toContain("grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2");
  });

  it("shows the persisted venue above the chat without loading Google UI", () => {
    const page = readSource("src/routes/FeedbackInboxPage.tsx");
    const header = readSource(
      "src/components/admin/feedback/CampaignHeader.tsx",
    );

    expect(page).toContain("venue={eventQuery.data?.venue ?? null}");
    expect(page).toContain("refetchOnWindowFocus: true");
    expect(header).toContain("<VenueCompact");
    expect(header).toContain('aria-label="Dinner venue"');
    expect(header).not.toContain("GooglePlaceDetails");
    expect(header).not.toContain("loadGooglePlaces");
  });

  it("starts a conversation from the candidate's own row in the list", () => {
    const page = readSource("src/routes/FeedbackInboxPage.tsx");
    const list = readSource(
      "src/components/admin/feedback/ConversationList.tsx",
    );

    // D17 is a row in the NOT STARTED group, not a standalone button over a
    // picker dialog: the page derives candidates (present, no conversation)
    // and each row grows its confirmed «Start» on hover or keyboard focus.
    expect(page).toContain("startCandidates");
    expect(page).toContain("attendee.present");
    expect(list).toContain("Not started");
    expect(list).toContain("group-focus-within:opacity-100");
    expect(list).toContain("<ConfirmAction");
  });

  it("shows the polling refresh in both live panes without a live region", () => {
    const page = readSource("src/routes/FeedbackInboxPage.tsx");
    const indicator = readSource("src/components/ui/JtsLiveIndicator.tsx");

    expect(page).toContain("isRefreshing={listQuery.isFetching}");
    expect(page).toContain("isRefreshing={detailQuery.isFetching}");
    // Callers stay dumb: hysteresis lives in the indicator, not the page.
    expect(indicator).toContain("resolveLiveIndicatorPainted");
    // A two-second poll must not announce itself over and over.
    expect(indicator).not.toContain("aria-live");
    expect(indicator).not.toContain('role="status"');
    expect(indicator).toContain("sr-only");
  });
});

describe("selection under polling", () => {
  it("keeps the operator's conversation while it survives the filter", () => {
    const visible = [{ id: "a" }, { id: "b" }];

    expect(view.resolveSelectedConversationId(visible, "b")).toBe("b");
  });

  it("falls back to the first row when the selection is gone", () => {
    expect(view.resolveSelectedConversationId([{ id: "a" }], "missing")).toBe(
      "a",
    );
    expect(view.resolveSelectedConversationId([], "missing")).toBeNull();
  });

  it("keeps a sticky fallback when the list reorders under polling", () => {
    // Desktop with no ?conversation=: first resolve lands on the head row.
    expect(
      view.resolveSelectedConversationId(
        [{ id: "a" }, { id: "b" }],
        null,
        null,
      ),
    ).toBe("a");
    // A newer message promotes b to the head — the open pane must not follow.
    expect(
      view.resolveSelectedConversationId([{ id: "b" }, { id: "a" }], null, "a"),
    ).toBe("a");
  });

  it("drops the sticky fallback once that row leaves the visible set", () => {
    expect(
      view.resolveSelectedConversationId([{ id: "b" }, { id: "c" }], null, "a"),
    ).toBe("b");
  });

  it("prefers the URL over a sticky fallback", () => {
    expect(
      view.resolveSelectedConversationId([{ id: "a" }, { id: "b" }], "b", "a"),
    ).toBe("b");
  });

  it("wires the sticky ref into the inbox page resolve", () => {
    const page = readSource("src/routes/FeedbackInboxPage.tsx");
    expect(page).toContain("stickySelectedRef");
    expect(page).toContain(
      "resolveSelectedConversationId(\n    visible,\n    requestedId,\n    stickySelectedRef.current,\n  )",
    );
  });

  it("does not treat a stale requested id as an opened mobile thread", () => {
    expect(view.hasExplicitConversationSelection("b", "b")).toBe(true);
    expect(view.hasExplicitConversationSelection("missing", "a")).toBe(false);
    expect(view.hasExplicitConversationSelection(null, "a")).toBe(false);
  });
});

describe("staff composer idempotency", () => {
  it("keeps the exact text and client id after an unknown or failed send", () => {
    const empty = staffMessageDraft.createStaffMessageDraft(() => "draft-1");
    const written = staffMessageDraft.editStaffMessageDraft(
      empty,
      "Γεια σου",
      () => "draft-2",
    );
    const failed = staffMessageDraft.settleStaffMessageDraft(
      written,
      "draft-2",
      false,
      () => "must-not-rotate",
    );

    expect(failed).toBe(written);
    expect(failed).toEqual({ text: "Γεια σου", clientMessageId: "draft-2" });
  });

  it("rotates on edit and only clears the exact successfully sent draft", () => {
    const written = { text: "Γεια σου", clientMessageId: "draft-1" };
    const edited = staffMessageDraft.editStaffMessageDraft(
      written,
      "Γεια σου ξανά",
      () => "draft-2",
    );

    expect(edited.clientMessageId).toBe("draft-2");
    expect(
      staffMessageDraft.settleStaffMessageDraft(
        edited,
        "draft-1",
        true,
        () => "must-not-clear-newer-draft",
      ),
    ).toBe(edited);
    expect(
      staffMessageDraft.settleStaffMessageDraft(
        edited,
        "draft-2",
        true,
        () => "draft-3",
      ),
    ).toEqual({ text: "", clientMessageId: "draft-3" });
  });

  it("passes the draft identity through the generated mutation and preserves failures", () => {
    const page = readSource("src/routes/FeedbackInboxPage.tsx");
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );

    expect(page).toContain("data: { clientMessageId, text }");
    expect(page).toContain("return false");
    expect(transcript).toContain("settleStaffMessageDraft(");
    expect(transcript).not.toContain('setStaffText("")');
  });
});

describe("simulator composer idempotency", () => {
  it("keeps one stable inject key until the exact draft succeeds", () => {
    const facade = readSource("src/lib/feedbackSimulator.ts");
    const page = readSource("src/routes/FeedbackInboxPage.tsx");
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );

    expect(facade).toContain("idempotencyKey: string");
    expect(facade).toContain("idempotencyKey: variables.idempotencyKey");
    expect(page).toContain("text: string,\n    idempotencyKey: string,");
    expect(page).toContain("idempotencyKey,");
    expect(transcript).toContain("submittedIdempotencyKey");
    expect(transcript).toContain("settleSimulatorMessageDraft(");
    expect(transcript).not.toContain('setSimulatedText("")');
  });

  it("preserves a failed simulator draft and rotates it only after success", () => {
    const written = { text: "Ήταν τέλεια", clientMessageId: "sim-draft-1" };

    expect(
      staffMessageDraft.settleStaffMessageDraft(
        written,
        "sim-draft-1",
        false,
        () => "must-not-rotate",
      ),
    ).toBe(written);
    expect(
      staffMessageDraft.settleStaffMessageDraft(
        written,
        "sim-draft-1",
        true,
        () => "sim-draft-2",
      ),
    ).toEqual({ text: "", clientMessageId: "sim-draft-2" });
  });
});

describe("polling policy (U3)", () => {
  it("polls an open conversation faster than the list", () => {
    expect(polling.CONVERSATION_POLL_INTERVAL_MS).toBeLessThan(
      polling.CONVERSATION_LIST_POLL_INTERVAL_MS,
    );
    expect(polling.CONVERSATION_POLL_INTERVAL_MS).toBe(2_000);
    expect(polling.CONVERSATION_LIST_POLL_INTERVAL_MS).toBe(5_000);
  });

  it("stops polling a conversation that can no longer change", () => {
    expect(
      polling.conversationPollInterval({ lifecycle: { state: "closed" } }),
    ).toBe(false);
    expect(
      polling.conversationPollInterval({ lifecycle: { state: "open" } }),
    ).toBe(polling.CONVERSATION_POLL_INTERVAL_MS);
    expect(polling.conversationPollInterval(undefined)).toBe(
      polling.CONVERSATION_POLL_INTERVAL_MS,
    );
  });
});

describe("campaign summary copy", () => {
  const summaryNow = new Date("2026-08-01T12:02:00.000Z");
  const summaryStatus = (
    overrides: Partial<TestSummaryStatus> & {
      status: TestSummaryStatus["status"];
    },
  ): TestSummaryStatus => ({
    isPartial: false,
    requestedAt: "2026-08-01T12:00:00.000Z",
    executionEpoch: 0,
    claimExpiresAt: null,
    ...overrides,
  });

  it("names each status for the collapsed header", () => {
    expect(
      campaignSummary.campaignSummaryStatusLabel(
        summaryStatus({ status: "none", requestedAt: null }),
        summaryNow,
      ),
    ).toBe("Not generated");
    expect(
      campaignSummary.campaignSummaryStatusLabel(
        summaryStatus({
          status: "pending",
          executionEpoch: 1,
          claimExpiresAt: "2026-08-01T12:08:00.000Z",
        }),
        summaryNow,
      ),
    ).toBe("Generating… (2 min)");
    expect(
      campaignSummary.campaignSummaryStatusLabel(
        summaryStatus({ status: "ready" }),
        summaryNow,
      ),
    ).toBe("Ready");
    expect(
      campaignSummary.campaignSummaryStatusLabel(
        summaryStatus({ status: "ready", isPartial: true }),
        summaryNow,
      ),
    ).toBe("Partial");
    expect(
      campaignSummary.campaignSummaryStatusLabel(
        summaryStatus({ status: "failed" }),
        summaryNow,
      ),
    ).toBe("Failed");
  });

  it("splits a pending row by whether an execution claim is live", () => {
    const pending = (
      overrides: Partial<TestSummaryStatus>,
    ): TestSummaryStatus => summaryStatus({ status: "pending", ...overrides });

    // Requested, never claimed: BullMQ still owes the first execution.
    expect(
      campaignSummary.campaignSummaryPendingPhase(
        pending({ executionEpoch: 0, claimExpiresAt: null }),
        summaryNow,
      ),
    ).toBe("queued");
    // A worker holds the lease and is inside the model call.
    expect(
      campaignSummary.campaignSummaryPendingPhase(
        pending({
          executionEpoch: 1,
          claimExpiresAt: "2026-08-01T12:08:00.000Z",
        }),
        summaryNow,
      ),
    ).toBe("generating");
    // Released by a run that failed retryably — same row, nobody generating.
    expect(
      campaignSummary.campaignSummaryPendingPhase(
        pending({ executionEpoch: 1, claimExpiresAt: null }),
        summaryNow,
      ),
    ).toBe("retrying");
    // The worker died mid-call, so its lease lapsed instead of being released.
    expect(
      campaignSummary.campaignSummaryPendingPhase(
        pending({
          executionEpoch: 2,
          claimExpiresAt: "2026-08-01T12:01:00.000Z",
        }),
        summaryNow,
      ),
    ).toBe("retrying");
    // Every other status clears the lease fields and owes no execution.
    expect(
      campaignSummary.campaignSummaryPendingPhase(
        summaryStatus({ status: "ready" }),
        summaryNow,
      ),
    ).toBeNull();
    expect(
      campaignSummary.campaignSummaryPendingPhase(
        summaryStatus({ status: "failed" }),
        summaryNow,
      ),
    ).toBeNull();
  });

  it("distinguishes a live generation from a queued retry in the header", () => {
    expect(
      campaignSummary.campaignSummaryStatusLabel(
        summaryStatus({
          status: "pending",
          executionEpoch: 0,
          claimExpiresAt: null,
          requestedAt: "2026-08-01T12:01:55.000Z",
        }),
        summaryNow,
      ),
    ).toBe("Queued (5 s)");
    expect(
      campaignSummary.campaignSummaryStatusLabel(
        summaryStatus({
          status: "pending",
          executionEpoch: 1,
          claimExpiresAt: "2026-08-01T12:08:00.000Z",
          requestedAt: "2026-08-01T11:47:00.000Z",
        }),
        summaryNow,
      ),
    ).toBe("Generating… (15 min)");
    // The epoch counts executions started, so the held retry is the next one.
    expect(
      campaignSummary.campaignSummaryStatusLabel(
        summaryStatus({
          status: "pending",
          executionEpoch: 1,
          claimExpiresAt: null,
          requestedAt: "2026-08-01T11:46:00.000Z",
        }),
        summaryNow,
      ),
    ).toBe("Waiting to retry — attempt 2 (16 min)");
    // A row whose request timestamp is missing still names the state.
    expect(
      campaignSummary.campaignSummaryStatusLabel(
        summaryStatus({
          status: "pending",
          executionEpoch: 3,
          claimExpiresAt: null,
          requestedAt: null,
        }),
        summaryNow,
      ),
    ).toBe("Waiting to retry — attempt 4");
  });

  it("counts the wait from the request, through seconds, minutes and hours", () => {
    const elapsed = (requestedAt: string) =>
      campaignSummary.campaignSummaryElapsedLabel(requestedAt, summaryNow);

    expect(elapsed("2026-08-01T12:02:00.000Z")).toBe("0 s");
    expect(elapsed("2026-08-01T12:01:01.000Z")).toBe("59 s");
    expect(elapsed("2026-08-01T12:01:00.000Z")).toBe("1 min");
    expect(elapsed("2026-08-01T11:03:00.000Z")).toBe("59 min");
    expect(elapsed("2026-08-01T11:02:00.000Z")).toBe("1 h");
    expect(elapsed("2026-08-01T08:45:00.000Z")).toBe("3 h 17 min");
    // A clock that reads ahead of the row must not produce a negative wait.
    expect(elapsed("2026-08-01T12:05:00.000Z")).toBe("0 s");
    expect(campaignSummary.campaignSummaryElapsedLabel(null, summaryNow)).toBe(
      null,
    );
  });

  it("says which side is holding the work while a summary is owed", () => {
    expect(campaignSummary.campaignSummaryPendingDetail("queued")).toBe(
      "Queued for generation. A worker picks it up as soon as one is free.",
    );
    expect(campaignSummary.campaignSummaryPendingDetail("generating")).toBe(
      "Generating the summary…",
    );
    expect(campaignSummary.campaignSummaryPendingDetail("retrying")).toBe(
      "The last run stopped before it finished. The summary is still owed — the queued retry starts once its backoff elapses.",
    );
  });

  it("offers Generate for a missing or failed summary, Refresh otherwise", () => {
    expect(campaignSummary.campaignSummaryActionLabel("none")).toBe("Generate");
    expect(campaignSummary.campaignSummaryActionLabel("failed")).toBe(
      "Generate",
    );
    expect(campaignSummary.campaignSummaryActionLabel("ready")).toBe("Refresh");
    expect(campaignSummary.campaignSummaryActionLabel("pending")).toBe(
      "Refresh",
    );
  });

  it("warns only when the summary is partial", () => {
    expect(
      campaignSummary.campaignSummaryPartialWarning({
        isPartial: false,
        openConversationCount: 2,
      }),
    ).toBeNull();
    expect(
      campaignSummary.campaignSummaryPartialWarning({
        isPartial: true,
        openConversationCount: 1,
      }),
    ).toBe("Based on incomplete data — 1 conversation was still open.");
    expect(
      campaignSummary.campaignSummaryPartialWarning({
        isPartial: true,
        openConversationCount: 3,
      }),
    ).toBe("Based on incomplete data — 3 conversations were still open.");
    expect(
      campaignSummary.campaignSummaryPartialWarning({
        isPartial: true,
        openConversationCount: null,
      }),
    ).toBe("Based on incomplete data — some conversations were still open.");
  });

  /**
   * Structured v2 summaries render as metric/list cards. Legacy markdown bodies
   * still share the assistant renderer so an older ready row stays readable
   * until staff refresh it.
   */
  it("renders structured summary cards and keeps a legacy markdown fallback", () => {
    const component = readFileSync(
      fileURLToPath(
        new URL(
          "../src/components/admin/feedback/CampaignSummary.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(component).toContain("StructuredSummary");
    expect(component).toContain("SummaryMetrics");
    expect(component).toContain("ScoreRangeRow");
    expect(component).toContain("DirectedChip");
    expect(component).toContain("TintedFindingCard");
    expect(component).toContain("summary?.document");
    expect(component).toContain(
      'import { AssistantMarkdown } from "../assistant/AssistantMarkdown"',
    );
    expect(component).toContain('className="assistant-markdown max-w-none"');
    expect(component).toContain(
      "<AssistantMarkdown>{legacyBody}</AssistantMarkdown>",
    );
    expect(component).not.toContain('from "react-markdown"');
    expect(component).not.toContain('from "remark-gfm"');

    // Grouped report inside one accordion frame: sunken washes + padding for
    // islands, no nested borders/shadows competing with the disclosure.
    expect(component).toContain("ReportIsland");
    expect(component).toContain("The night in numbers");
    expect(component).toContain("How it felt");
    expect(component).toContain("bg-primary");
    expect(component).toContain("bg-surface-sunken");
    // Well/wrong are quiet surface cards with a 3px left marker; intensity is
    // per-row via weight (SignalLow/Medium/High) + soft fills.
    expect(component).toContain("border-l-[3px] border-l-success");
    expect(component).toContain("border-l-[3px] border-l-danger");
    expect(component).toContain("bg-surface");
    expect(component).toContain("FINDING_WEIGHT_GLYPHS");
    expect(component).toContain("SignalHigh");
    expect(component).toContain("findingRowClass");
    expect(component).toContain("SCORE_METRIC_GLYPHS");
    expect(component).toContain("bg-rose-soft");
    expect(component).toContain("text-rose");
    expect(component).toContain("border-rose-border");
    expect(component).toContain("bg-warning-soft");
    expect(component).toContain("Who people named");
    expect(component).toContain("Τι πήγε καλά");
    expect(component).toContain("Τι στράβωσε");
    expect(component).not.toContain("What went well");
    expect(component).not.toContain("What went wrong");
    expect(component).toContain("Αξιοπερίεργα");
    expect(component).toContain("GossipDrawer");
    expect(component).toContain("Accordion");
    expect(component).toContain("Accordion.Indicator");
    expect(component).toContain("Disclosure");
    expect(component).toContain("Disclosure.Indicator");
    expect(component).not.toContain("jts-disclosure");
    expect(component).toContain("💅");
    expect(component).not.toContain("Drama");
    expect(component).toContain("Κουτσομπολιό");
    expect(component).toContain("BulletList");
    expect(component).toContain("list-disc");
    expect(component).toContain("ActionList");
    expect(component).toContain("ChevronRight");
    expect(component).toContain("document.curiosities");
    expect(component).toContain("document.gossip");
    expect(component).not.toContain("What stood out");
    expect(component).not.toContain("document.highlights");
    expect(component).toContain("rounded-xl bg-surface-sunken px-4 py-4");
    expect(component).not.toContain("shadow-xs");
    // Nested islands must not re-frame themselves; the accordion already does.
    expect(component).not.toContain(
      "rounded-xl border border-border bg-surface",
    );

    // The expanded disclosure is nested Grid all the way down. Every level
    // needs an explicit zero-minimum track or a long summary widens the inner
    // track past the mobile card while the document itself stays 375px wide.
    expect(component).toContain(
      'className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 border-t border-border px-4 py-5 text-ink sm:px-5"',
    );
    expect(component).toContain(
      'className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5"',
    );
    expect(component).toContain(
      'className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 rounded-xl bg-surface-sunken px-4 py-4 sm:px-5 sm:py-5"',
    );
    expect(component).toContain("sm:min-w-[12rem]");
    expect(component).not.toContain("flex min-w-[12rem]");

    // Everything visual comes from the bridge, so there is no literal colour
    // and no theme branching to flatten it.
    expect(component).not.toContain("dark:");
    expect(component).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/iu);
  });
});

describe("campaign picker", () => {
  it("renders campaigns from the generated listFeedbackCampaigns hook", () => {
    const page = readFileSync(
      fileURLToPath(
        new URL("../src/routes/FeedbackCampaignsPage.tsx", import.meta.url),
      ),
      "utf8",
    );

    expect(page).toContain("useListFeedbackCampaigns");
    expect(page).toContain('from "../api/generated/feedback-campaigns"');
    expect(page).toContain("useLaunchFeedbackCampaign");
    // Launch is a deliberate write; the picker must not treat it as navigation.
    expect(page).toContain("intro message");
    expect(page).not.toContain("recentCampaigns");
    expect(page).not.toContain("localStorage");
  });

  it("keeps campaign cards inside a narrow viewport", () => {
    const page = readFileSync(
      fileURLToPath(
        new URL("../src/routes/FeedbackCampaignsPage.tsx", import.meta.url),
      ),
      "utf8",
    );

    // Without an explicit zero-minimum base track, CSS Grid sizes its implicit
    // column from the no-wrap title plus status badge and widens the document.
    expect(page).toContain(
      'className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"',
    );
    expect(page).toContain(
      'className="block min-w-0 flex-1 truncate text-sm font-bold text-ink"',
    );
  });
});

/* -------------------------------------------------------------------------- */

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "generated") {
        continue;
      }
      files.push(...collectSourceFiles(path));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

describe("API contract boundary", () => {
  it("adds no hand-written endpoint beyond the two documented exceptions", () => {
    // The assistant predates the generated client and owns extra client-side
    // polling semantics (docs/frontend/assistant.md); the dev simulator is
    // absent from the published OpenAPI document by design. Nothing else may
    // call the transport directly — a third entry here means a product
    // endpoint bypassed the generated hooks.
    const callers = collectSourceFiles(sourceRoot)
      .filter((path) => {
        if (
          path.endsWith("/lib/api.ts") ||
          path.endsWith("/lib/api-mutator.ts")
        ) {
          return false;
        }
        return /\bapi\(\s*[`"']/u.test(readFileSync(path, "utf8"));
      })
      .map((path) => path.slice(sourceRoot.length))
      .sort();

    expect(callers).toStrictEqual([
      "/lib/feedbackSimulator.ts",
      "/routes/AssistantPage.tsx",
    ]);
  });

  it("limits that exception to the two dev-only simulator routes", () => {
    const facade = readFileSync(
      `${sourceRoot}/lib/feedbackSimulator.ts`,
      "utf8",
    );

    expect(facade).toContain('"/v1/dev/feedback/simulator"');
    expect(facade).toContain("/thread");
    expect(facade).toContain("/inject");
    // Anything on the product path must come from the generated client.
    expect(facade).not.toContain("/v1/feedback/campaigns");
  });

  it("drives the inbox screen from the generated hooks", () => {
    const page = readFileSync(
      fileURLToPath(
        new URL("../src/routes/FeedbackInboxPage.tsx", import.meta.url),
      ),
      "utf8",
    );

    for (const hook of [
      "useListFeedbackCampaignConversations",
      "useGetFeedbackConversation",
      "useListFeedbackConversationResults",
      "useTakeOverFeedbackConversation",
      "useResumeFeedbackConversationBot",
      "useCloseFeedbackConversation",
      "useSendFeedbackConversationStaffMessage",
      "useUpdateFeedbackNoteReviewStatus",
      "useResolveFeedbackConversationAttentionReason",
      "useStartFeedbackConversation",
      "useAddFeedbackConversationNote",
      "useCorrectFeedbackConversationAnswer",
      "useWithdrawFeedbackConversationAnswer",
    ]) {
      expect(page).toContain(hook);
    }

    expect(page).toContain('from "../api/generated/feedback-conversations"');
    expect(page).not.toContain("ofetch");
  });

  it("gates conversation actions on the server's capability flags", () => {
    const details = readFileSync(
      fileURLToPath(
        new URL(
          "../src/components/admin/feedback/ConversationDetails.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(details).toContain("capabilities.canTakeOver");
    expect(details).toContain("capabilities.canResumeBot");
    expect(details).toContain("capabilities.canClose");
  });

  it("keeps conversation actions in the transcript header, compact on mobile", () => {
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );
    const details = readSource(
      "src/components/admin/feedback/ConversationDetails.tsx",
    );

    // Opposite the contact block — not a second foot strip of buttons.
    const headerClose = transcript.indexOf("</header>");
    const actionsSlot = transcript.indexOf("{actions}");
    expect(actionsSlot).toBeGreaterThan(-1);
    expect(actionsSlot).toBeLessThan(headerClose);
    expect(transcript.indexOf("{actions}", headerClose)).toBe(-1);

    // Close is always icon-only; Take over / Resume collapse below `sm` so a
    // Greek full name still fits the header line on a phone.
    const closeBlock = details.indexOf('label="Close"');
    expect(closeBlock).toBeGreaterThan(-1);
    expect(details.slice(closeBlock, closeBlock + 80)).toContain("isIconOnly");
    expect(details).toContain('collapseLabelAt="sm"');
  });

  it("caps panes against the large viewport, not the dynamic one", () => {
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );
    const list = readSource(
      "src/components/admin/feedback/ConversationList.tsx",
    );

    // `dvh` reflows when mobile browser chrome shows or hides; `lvh` stays put.
    expect(transcript).toContain("max-h-[calc(100lvh-10rem)]");
    expect(transcript).not.toContain("100dvh-10rem");
    expect(list).toContain("lg:max-h-[calc(100lvh-10rem)]");
    expect(list).not.toContain("100dvh-10rem");
  });

  it("covers the narrow thread as a fixed fullscreen on the same mount", () => {
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );
    const page = readSource("src/routes/FeedbackInboxPage.tsx");

    // Same tree — no Modal remount that would drop a typed reply. Cover state
    // is `?fullscreen=1` so platform back steps out before leaving the thread;
    // open sits beside «Back to conversations», not next to Take over / Close.
    expect(page).toContain('searchParams.get("fullscreen") === "1"');
    expect(page).toContain('next.set("fullscreen", "1")');
    expect(page).toContain("Open conversation fullscreen");
    expect(page).toContain("Maximize2");
    expect(page).toContain("isFullscreen={fullscreenOnNarrow}");
    expect(transcript).toContain("Minimize2");
    expect(transcript).toContain("Exit fullscreen conversation");
    expect(transcript).toContain("fixed inset-0 z-50 h-lvh max-h-none");
    expect(transcript).not.toContain("Maximize2");
    expect(transcript).not.toContain('size="cover"');
  });
});
