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
  deliveryBadge: (delivery: unknown) => { label: string; tone: string } | null;
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
}

interface ConversationViewModule {
  goalProgress: (goals: { status: GoalStatus }[]) => {
    answered: number;
    skipped: number;
    outstanding: number;
    settled: number;
    total: number;
  };
  matchesConversationQuery: (
    conversation: {
      respondentDisplayName: string | null;
      phoneAtLaunch: string;
    },
    query: string,
  ) => boolean;
  sortConversationsForInbox: (rows: TestConversation[]) => TestConversation[];
  groupConversations: (
    rows: TestConversation[],
  ) => { key: string; title: string; conversations: TestConversation[] }[];
  CONVERSATION_GROUP_TITLES: Record<string, string>;
  resolveSelectedConversationId: (
    visible: { id: string }[],
    requested: string | null,
  ) => string | null;
  conversationBadges: (
    conversation: TestConversation,
  ) => { key: string; label: string; tone: string; emphasis?: string }[];
  conversationRowBadges: (
    conversation: TestConversation,
    group: "attention" | "open" | "closed",
  ) => { key: string; label: string; tone: string; emphasis?: string }[];
  transcriptMessageAnchorId: (messageId: string) => string;
}

interface PollingModule {
  conversationPollInterval: (
    conversation: { lifecycle: { state: "open" | "closed" } } | undefined,
  ) => number | false;
  CONVERSATION_POLL_INTERVAL_MS: number;
  CONVERSATION_LIST_POLL_INTERVAL_MS: number;
}

interface ExtractionStatusModule {
  extractionStatusLines: (
    extraction: {
      unreadParticipantMessages: number;
      lastRunAt: string | null;
      model: string | null;
      nextRunAt: string | null;
      runInFlight: boolean;
      runQueued: boolean;
      lastRunFailed: boolean;
      failedReason: string | null;
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

interface StaffCloseModule {
  STAFF_CLOSE_REASONS: readonly string[];
  staffCloseReasonLabel: (reason: string) => string;
  staffCloseSummary: (staffClose: {
    reason: string;
    note: string | null;
  }) => string;
}

let labels: LabelsModule;
let view: ConversationViewModule;
let polling: PollingModule;
let extractionStatus: ExtractionStatusModule;
let answerCorrections: AnswerCorrectionsModule;
let staffClose: StaffCloseModule;

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
  staffClose = await loadFeatureModule<StaffCloseModule>(
    "src/features/feedback/staffClose.ts",
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

describe("inbox filtering", () => {
  it("folds accents and case so Greek names match either way", () => {
    const row = { respondentDisplayName: "Κώστας", phoneAtLaunch: "+3069" };

    expect(view.matchesConversationQuery(row, "κωστας")).toBe(true);
    expect(view.matchesConversationQuery(row, "ΚΩΣΤΑΣ")).toBe(true);
    expect(view.matchesConversationQuery(row, "Κώστας")).toBe(true);
    expect(view.matchesConversationQuery(row, "Ρούλα")).toBe(false);
  });

  it("matches on the phone number and passes an empty query", () => {
    const row = {
      respondentDisplayName: null,
      phoneAtLaunch: "+306912345678",
    };

    expect(view.matchesConversationQuery(row, "69123")).toBe(true);
    expect(view.matchesConversationQuery(row, "  ")).toBe(true);
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

  it("keeps the lifecycle in that group, because open and stopped differ there", () => {
    // Both need a human; only one can still be replied to. That distinction is
    // the reason the chip survives the heading.
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

    expect(open.map((badge) => badge.label)).toStrictEqual(["Open"]);
    expect(stopped.map((badge) => badge.label)).toStrictEqual(["Stopped"]);
  });

  it("leaves an ordinary open conversation with no chips at all", () => {
    expect(
      view.conversationRowBadges(conversation({ id: "a" }), "open"),
    ).toStrictEqual([]);
  });

  it("keeps the closing reason but not the bare word the heading already says", () => {
    const completed = view.conversationRowBadges(
      conversation({
        id: "a",
        lifecycle: { state: "closed", reason: "completed" },
      }),
      "closed",
    );
    const unexplained = view.conversationRowBadges(
      conversation({ id: "b", lifecycle: { state: "closed", reason: null } }),
      "closed",
    );

    expect(completed.map((badge) => badge.label)).toStrictEqual(["Completed"]);
    expect(unexplained).toStrictEqual([]);
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

  it("leaves the transcript header the full set, having no heading above it", () => {
    const full = view.conversationBadges(
      conversation({ id: "a", needsAttention: true }),
    );

    expect(full.map((badge) => badge.label)).toStrictEqual([
      "Open",
      "Needs attention",
    ]);
  });

  it("wires the two readers to the badge set each one needs", () => {
    expect(
      readSource("src/components/admin/feedback/ConversationList.tsx"),
    ).toContain("conversationRowBadges(");
    expect(
      readSource("src/components/admin/feedback/ConversationTranscript.tsx"),
    ).toContain("conversationBadges(");
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

  it("shows the badge row on inbox rows and in the conversation header", () => {
    expect(
      readSource("src/components/admin/feedback/ConversationList.tsx"),
    ).toContain("<FeedbackBadges");
    expect(
      readSource("src/components/admin/feedback/ConversationTranscript.tsx"),
    ).toContain("<FeedbackBadges");
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

  it("highlights the cited transcript message and labels the action in text", () => {
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );

    expect(transcript).toContain("message.attention");
    expect(transcript).toContain("bg-warning-soft");
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
    for (const file of [
      "src/components/admin/feedback/ConversationTranscript.tsx",
      "src/components/admin/feedback/ConversationAttention.tsx",
    ]) {
      expect(readSource(file)).toContain("transcriptMessageAnchorId");
    }
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
    nextRunAt: null as string | null,
    runInFlight: false,
    runQueued: false,
    lastRunFailed: false,
    failedReason: null as string | null,
  };

  it("names how far behind the reading is, in Greek", () => {
    expect(
      extractionStatus.extractionStatusLines({
        ...idle,
        unreadParticipantMessages: 3,
      }).unread,
    ).toBe("3 μηνύματα δεν έχουν διαβαστεί ακόμα.");
    expect(
      extractionStatus.extractionStatusLines({
        ...idle,
        unreadParticipantMessages: 1,
      }).unread,
    ).toBe("1 μήνυμα δεν έχει διαβαστεί ακόμα.");
  });

  it("shows a due time rather than a spinner when a run is scheduled", () => {
    const lines = extractionStatus.extractionStatusLines(
      {
        ...idle,
        unreadParticipantMessages: 2,
        nextRunAt: "2026-07-27T11:47:00.000Z",
        runQueued: true,
      },
      new Date("2026-07-27T11:00:00.000Z"),
    );

    expect(lines.schedule).toMatch(/^Επόμενη ανάγνωση /);
    expect(lines.attention).toBe("pending");
  });

  it("shows failure as failure, with the fallback named", () => {
    const lines = extractionStatus.extractionStatusLines({
      ...idle,
      unreadParticipantMessages: 1,
      lastRunFailed: true,
      failedReason: "Feedback extraction failed permanently: provider_refusal",
    });

    expect(lines.schedule).toBe(
      "Η ανάγνωση απέτυχε · απάντησε η εναλλακτική διαδικασία.",
    );
    expect(lines.attention).toBe("danger");
  });

  it("admits when the queue state is unknown rather than inventing idle", () => {
    const lines = extractionStatus.extractionStatusLines({
      ...idle,
      unreadParticipantMessages: 2,
    });

    expect(lines.schedule).toBe("Ώρα επόμενης ανάγνωσης άγνωστη.");
    expect(lines.attention).toBe("pending");
  });

  it("renders the status block as a polite live region without a spinner", () => {
    const details = readSource(
      "src/components/admin/feedback/ConversationDetails.tsx",
    );

    expect(details).toContain("extractionStatusLines");
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
    expect(details).toContain("answer.questionKey === goal.key");
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

  it("reads the messages it is about, at the foot of the transcript", () => {
    const transcript = readSource(
      "src/components/admin/feedback/ConversationTranscript.tsx",
    );

    // «Why has that answer not appeared yet» is a question about these
    // messages, so it is answered under them rather than in a reference card
    // three columns away.
    expect(transcript).toContain("<ReadingStatus conversation={conversation}");
    expect(readSource("src/routes/FeedbackInboxPage.tsx")).not.toContain(
      "ReadingStatus",
    );
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
    // On liked / meet_again / avoid the subject *is* the answer and `valueInt`
    // is null, so a 1–5 picker there would ask an operator to assert something
    // the question cannot express.
    expect(answerCorrections.canCorrectAnswerValue(score)).toBe(true);
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

    expect(details).toContain("<AnswerValue");
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
  it("reads «All campaigns» as a back affordance, not a campaign action", () => {
    const page = readSource("src/components/admin/feedback/CampaignHeader.tsx");
    const header = page.slice(0, page.indexOf("<JtsPageHeader"));

    // It leaves the campaign, so it sits above the header with a left chevron
    // rather than beside the actions that operate on the campaign — the same
    // glyph the participant profile's back link uses.
    expect(header).toContain("All campaigns");
    expect(header).toContain("ChevronLeft");
  });

  it("keeps «Start conversation» beside the list it adds a row to", () => {
    const page = readSource("src/routes/FeedbackInboxPage.tsx");
    const list = readSource(
      "src/components/admin/feedback/ConversationList.tsx",
    );

    expect(page).toContain("startAction:");
    expect(list).toContain("startAction");
    // Not a page-level toolbar item any more.
    expect(page.indexOf("<StartConversationAction")).toBeGreaterThan(
      page.indexOf("<ConversationList"),
    );
  });

  it("shows the polling refresh in both live panes without a live region", () => {
    const page = readSource("src/routes/FeedbackInboxPage.tsx");
    const indicator = readSource("src/components/ui/JtsLiveIndicator.tsx");

    expect(page).toContain("isRefreshing={listQuery.isFetching}");
    expect(page).toContain("isRefreshing={detailQuery.isFetching}");
    // A three-second poll must not announce itself over and over.
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
});

describe("polling policy (U3)", () => {
  it("polls an open conversation faster than the list", () => {
    expect(polling.CONVERSATION_POLL_INTERVAL_MS).toBeLessThan(
      polling.CONVERSATION_LIST_POLL_INTERVAL_MS,
    );
    expect(polling.CONVERSATION_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(3_000);
    expect(polling.CONVERSATION_POLL_INTERVAL_MS).toBeLessThanOrEqual(5_000);
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
});
