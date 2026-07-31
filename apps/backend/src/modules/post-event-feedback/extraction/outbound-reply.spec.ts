import { describe, expect, it } from "vitest";

import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  renderPostEventFeedbackCopy,
} from "../question-set.js";
import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import { POST_EVENT_FEEDBACK_SAFETY_ASSURANCE } from "./extraction.schemas.js";
import {
  resolveOutbound,
  withCampaignReaskCap,
  withSafetyAssurance,
} from "./outbound-reply.js";

const copy = POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy;
const conversation = {
  _id: "conv-1",
  // Whether the assurance has already been said is read off the transcript, so
  // every fixture carries one.
  messages: [],
  // The closing copy thanks somebody for what they told us, so whether anything
  // was ever recorded is part of choosing it.
  goals: [
    {
      key: "event_score",
      ordinal: 1,
      prompt: copy.event_score,
      status: "answered",
    },
    { key: "liked", ordinal: 2, prompt: copy.liked, status: "asked" },
    {
      key: "meet_again",
      ordinal: 3,
      prompt: copy.meet_again,
      status: "pending",
    },
    { key: "avoid", ordinal: 4, prompt: copy.avoid, status: "pending" },
  ],
} as unknown as FeedbackConversationDocument;
const conversationWithNothingRecorded = {
  ...conversation,
  goals: conversation.goals.map((goal) => ({ ...goal, status: "skipped" })),
} as FeedbackConversationDocument;

function validated(
  overrides: Partial<FeedbackExtractionValidationResult> = {},
): FeedbackExtractionValidationResult {
  return {
    answers: [],
    notes: [],
    skippedGoals: [],
    nextGoal: "liked",
    reply: "Τέλεια, χαίρομαι πολύ! 🙂",
    replySuppressedReason: null,
    safetySignals: [],
    handoff: false,
    confidence: 0.9,
    rejections: [],
    conflictingAnswerRevision: false,
    ...overrides,
  };
}

describe("resolveOutbound", () => {
  it("re-asks the score when validation refused an out-of-range value, instead of confirming it", () => {
    const outbound = resolveOutbound(
      conversation,
      validated({
        nextGoal: "liked",
        reply: "Τέλεια, χαίρομαι πολύ! 🙂",
        rejections: [
          {
            scope: "answer",
            reason: "invalid_score",
            questionKey: "event_score",
          },
        ],
      }),
      false,
      false,
      2,
      copy,
      "event_score",
    );

    expect(outbound).toEqual({
      body: copy.event_score,
      dedupeKey: "feedback-reply-conv-1-2",
      askedGoal: "event_score",
    });
  });

  it("asks the next recorded-open goal when the model thanks the participant as if the questionnaire were finished", () => {
    // Directed answers were refused; the model still set nextGoal null and
    // wrote a closing thank-you. The refusals are what make the thank-you a
    // lie — without them, a nextGoal-null reply is how the bot answers a side
    // question, and must not be overwritten.
    const outbound = resolveOutbound(
      conversation,
      validated({
        nextGoal: null,
        reply: "Ευχαριστούμε για το feedback 🙂",
        rejections: [
          {
            scope: "answer",
            reason: "unresolved_subject",
            questionKey: "liked",
          },
          {
            scope: "answer",
            reason: "unresolved_subject",
            questionKey: "meet_again",
          },
        ],
      }),
      false,
      false,
      4,
      copy,
      "liked",
    );

    expect(outbound).toEqual({
      body: copy.liked,
      dedupeKey: "feedback-reply-conv-1-4",
      askedGoal: "liked",
    });
  });

  it("asks the recorded next goal when the model skipped ahead past an open one", () => {
    const outbound = resolveOutbound(
      conversation,
      validated({
        nextGoal: "avoid",
        reply:
          "Τέλεια, τα κράτησα! Υπάρχει κάποιος που θα προτιμούσες να μην ξαναπετύχεις;",
      }),
      false,
      false,
      3,
      copy,
      "liked",
    );

    expect(outbound).toEqual({
      body: copy.liked,
      dedupeKey: "feedback-reply-conv-1-3",
      askedGoal: "liked",
    });
  });

  it("re-asks a directed answer refused for an unresolvable name instead of advancing past it", () => {
    const outbound = resolveOutbound(
      conversation,
      validated({
        nextGoal: "avoid",
        reply:
          "Τέλεια, τα κράτησα! Υπάρχει κάποιος που θα προτιμούσες να μην ξαναπετύχεις;",
        rejections: [
          {
            scope: "answer",
            reason: "unresolved_subject",
            questionKey: "liked",
          },
          {
            scope: "answer",
            reason: "unresolved_subject",
            questionKey: "meet_again",
          },
        ],
      }),
      false,
      false,
      3,
      copy,
      "liked",
    );

    expect(outbound).toEqual({
      body: copy.liked,
      dedupeKey: "feedback-reply-conv-1-3",
      askedGoal: "liked",
    });
  });

  it("asks the question whose skip was refused, even though the model wrote a closing thank-you", () => {
    // The collapse, from the outbound side. «η Μαρία μου άρεσε, μαζί της θα
    // ξαναέβγαινα» came back as `meet_again` answered, `liked` declined and
    // `nextGoal: null` with a thank-you. Validation keeps `liked` open, and it
    // has to be *asked* here or nobody asks it: the branch below that catches a
    // model skipping ahead needs a question-shaped reply, and this proposal has
    // none.
    const outbound = resolveOutbound(
      conversation,
      validated({
        nextGoal: null,
        reply: "Τέλεια, ευχαριστούμε πολύ! 🙌",
        rejections: [
          {
            scope: "goal",
            reason: "declined_before_asked",
            questionKey: "liked",
          },
        ],
      }),
      false,
      false,
      6,
      copy,
      "liked",
    );

    expect(outbound).toEqual({
      body: copy.liked,
      dedupeKey: "feedback-reply-conv-1-6",
      askedGoal: "liked",
    });
  });

  it("asks the earliest refused question when a skip and an answer are both refused", () => {
    const outbound = resolveOutbound(
      conversation,
      validated({
        nextGoal: null,
        reply: null,
        rejections: [
          {
            scope: "goal",
            reason: "declined_before_asked",
            questionKey: "meet_again",
          },
          {
            scope: "answer",
            reason: "invalid_score",
            questionKey: "event_score",
          },
        ],
      }),
      false,
      false,
      7,
      copy,
      "event_score",
    );

    expect(outbound).toMatchObject({
      body: copy.event_score,
      askedGoal: "event_score",
    });
  });

  it("says nothing about a refused skip when the run carries an urgent safety signal", () => {
    // There is no approved copy for somebody who has just said they do not want
    // to be here, and a questionnaire prompt is the worst of the options. A lost
    // `liked` row does not outrank that.
    const outbound = resolveOutbound(
      conversation,
      validated({
        nextGoal: null,
        reply: "Λυπάμαι πολύ που το ακούω.",
        safetySignals: [
          {
            category: "self_harm",
            recommendedAction: "urgent_human_follow_up",
            sourceMessageIds: ["m1"],
            confidence: 0.9,
          },
        ],
        rejections: [
          {
            scope: "goal",
            reason: "declined_before_asked",
            questionKey: "liked",
          },
        ],
      }),
      false,
      true,
      8,
      copy,
      "liked",
    );

    expect(outbound).toBeUndefined();
  });

  it("still sends the campaign closing copy when recorded goals are actually terminal", () => {
    const outbound = resolveOutbound(
      conversation,
      validated({
        nextGoal: null,
        reply: "Ευχαριστούμε για το feedback 🙂",
      }),
      true,
      false,
      5,
      copy,
      null,
    );

    expect(outbound).toEqual({
      body: copy.closing,
      dedupeKey: "feedback-closing-conv-1",
    });
  });

  it("sends the bot's own goodbye, not a thank-you, when nothing was ever recorded", () => {
    // Μπάμπης Διπλογαμωσταυρίδης wrote «άντε γαμήσου ρε μαλακισμένο μποτ» and
    // got «Τέλεια, ευχαριστούμε πολύ! Ό,τι άλλο θες να μας πεις, είμαστε εδώ.
    // 🙌» — the model had declined every goal on that first message, completion
    // swapped in the campaign copy, and the line the model actually wrote for
    // him never left the building. There is nothing to thank him for.
    const outbound = resolveOutbound(
      conversationWithNothingRecorded,
      validated({
        nextGoal: null,
        reply: "Δίκαιο — το ερωτηματολόγιο μόλις έφαγε πόρτα 😅",
      }),
      true,
      false,
      5,
      copy,
      null,
    );

    expect(outbound).toMatchObject({
      body: "Δίκαιο — το ερωτηματολόγιο μόλις έφαγε πόρτα 😅",
    });
  });

  it("forwards the model's reply when the recorded next goal agrees with it", () => {
    const outbound = resolveOutbound(
      conversation,
      validated({
        nextGoal: "liked",
        reply: "Ποιος σου έκανε εντύπωση;",
      }),
      false,
      false,
      2,
      copy,
      "liked",
    );

    expect(outbound).toEqual({
      body: "Ποιος σου έκανε εντύπωση;",
      dedupeKey: "feedback-reply-conv-1-2",
      askedGoal: "liked",
    });
  });

  it("does not mark a goal asked when the bot bows out without posing a question", () => {
    // Μπάμπης Διπλογαμωσταυρίδης: the model still named nextGoal liked while
    // writing a withdrawal. The reminder ladder then restated liked the next
    // day — a question nobody had asked him.
    const outbound = resolveOutbound(
      conversation,
      validated({
        nextGoal: "liked",
        reply: "ΟΚ, το πιάνω — το bot αποσύρεται με σκυμμένο κεφάλι",
      }),
      false,
      false,
      4,
      copy,
      "liked",
    );

    expect(outbound).toEqual({
      body: "ΟΚ, το πιάνω — το bot αποσύρεται με σκυμμένο κεφάλι",
      dedupeKey: "feedback-reply-conv-1-4",
    });
    expect(outbound).not.toHaveProperty("askedGoal");
  });

  it("marks the goal asked when the bot asks in the imperative, without a question mark", () => {
    // Verbatim from the last rehearsal. Six of the eight punctuation-free
    // questions it produced were shaped like this, and reading them as
    // statements is not cosmetic: `isWithdrawal` keys off the same answer, so
    // it would settle every open goal and close a conversation that had just
    // asked for the score.
    for (const reply of [
      "Χαχα, εντάξει, δεν βιάζομαι 😄 Πέτα μου μόνο έναν αριθμό από το 1 ως το 5 για τη βραδιά και μετά συνεχίζουμε το ζύγισμα.",
      "Πάρε τον χρόνο σου 🙂 Όταν τα βάλεις σε σειρά, στείλε μου έστω έναν αριθμό από το 1 ως το 5.",
      "Λυπάμαι που ένιωσες έτσι — δεν ακούγεται καθόλου άνετο. Αν θες, πες μου και συνολικά πώς σου φάνηκε η βραδιά, από 1 ως 5.",
    ]) {
      expect(
        resolveOutbound(
          conversation,
          validated({ nextGoal: "event_score", reply }),
          false,
          false,
          4,
          copy,
          "event_score",
        ),
      ).toHaveProperty("askedGoal", "event_score");
    }
  });

  it("keeps the model's reply under a safety signal even when nextGoal is unset", () => {
    const outbound = resolveOutbound(
      conversation,
      validated({
        nextGoal: null,
        reply: "Λυπάμαι που το ακούω, θες να μιλήσουμε;",
        safetySignals: [
          {
            category: "other_safety",
            recommendedAction: "human_follow_up",
            sourceMessageIds: ["m1"],
            confidence: 0.9,
          },
        ],
      }),
      false,
      false,
      2,
      copy,
      "event_score",
    );

    // The assurance is the caller's to add — see `withSafetyAssurance` below.
    // What this case is about is that a `nextGoal: null` reply written under a
    // disclosure is forwarded rather than replaced by the next question.
    expect(outbound).toEqual({
      body: "Λυπάμαι που το ακούω, θες να μιλήσουμε;",
      dedupeKey: "feedback-reply-conv-1-2",
    });
  });
});

describe("withCampaignReaskCap", () => {
  /**
   * What `questionOutbound` produces: the campaign's own words for the goal,
   * keyed on the testimony seq — which is the half of the mechanism that let
   * the loop run, because every new participant message mints a fresh key and
   * the outbox fence never sees a duplicate.
   */
  const campaignQuestion = {
    body: copy.liked,
    dedupeKey: "feedback-reply-conv-1-9",
    askedGoal: "liked",
  } as const;

  function botSaid(...texts: readonly string[]): FeedbackConversationDocument {
    return {
      ...conversation,
      messages: texts.map((text, index) => ({
        id: `m-bot-${index + 1}`,
        actor: "bot",
        text,
      })),
    } as unknown as FeedbackConversationDocument;
  }

  it("lets the campaign's own words ask the same question a second time", () => {
    // The legitimate re-ask, and the one the cap must not touch: an answer was
    // refused, the goal is still open, and «you may not have seen this» is a
    // reasonable thing to say once.
    expect(
      withCampaignReaskCap(botSaid(copy.liked), campaignQuestion, copy),
    ).toEqual({ outbound: campaignQuestion, stalledOnMessageId: null });
  });

  it("refuses to send the identical campaign question a third time, and names the message to open", () => {
    // Paid rehearsal runs 13 and 14 (2026-07-31): «Υπήρχε κάποιος ή κάποια από
    // την παρέα που σου έκανε ιδιαίτερα καλή εντύπωση;» eleven times to one
    // guest and eight to another, one of whom answered «re eipa idi 3 fores, i
    // loyla!». The third send is where it stops being a question.
    expect(
      withCampaignReaskCap(
        botSaid(copy.liked, copy.liked),
        campaignQuestion,
        copy,
      ),
    ).toEqual({ outbound: undefined, stalledOnMessageId: "m-bot-2" });
  });

  it("anchors the stall on the bot's own message, so it is filed once rather than once per turn", () => {
    // The anchor is what makes the raise idempotent: `raiseAttention` dedupes
    // on kind plus message, and a bot message that has already been sent does
    // not move, however many more messages the participant writes. Anchoring on
    // the newest testimony instead would file one identical reason per turn.
    const stuck = botSaid(copy.liked, "κάτι άλλο εντελώς", copy.liked);

    expect(
      withCampaignReaskCap(stuck, campaignQuestion, copy).stalledOnMessageId,
    ).toBe("m-bot-3");
    // Same transcript, a later run, a later testimony seq: same anchor.
    expect(
      withCampaignReaskCap(
        stuck,
        { ...campaignQuestion, dedupeKey: "feedback-reply-conv-1-14" },
        copy,
      ).stalledOnMessageId,
    ).toBe("m-bot-3");
  });

  it("leaves a differently worded re-ask of the same goal alone", () => {
    // Rule 11δ forbids the model from repeating a question in the same words,
    // and the personas that get two differently worded re-asks are working as
    // intended. The cap counts identical bodies, not "this goal was asked
    // twice" — capping the model's own wording would break the one kind of
    // re-ask that still reads as somebody asking.
    const inItsOwnWords = {
      body: "Συγγνώμη που επιμένω 🙂 ποια Λούλα εννοείς, την Λούλα Γ.;",
      dedupeKey: "feedback-reply-conv-1-9",
      askedGoal: "liked",
    } as const;

    expect(
      withCampaignReaskCap(
        botSaid(copy.liked, copy.liked),
        inItsOwnWords,
        copy,
      ),
    ).toEqual({ outbound: inItsOwnWords, stalledOnMessageId: null });
  });

  it("does not count the reminder sweep's nudge, which quotes the question inside its own copy", () => {
    // `reminder_followup` restates the open question inside a wrapper, so the
    // campaign copy is a substring of it and never equal to it. Counting by
    // substring would spend a rung of the cap on a message that is not this
    // path's and reads nothing like a repeat.
    const nudge = renderPostEventFeedbackCopy(
      copy.reminder_followup,
      "Μαρία",
    ).replace("{question}", copy.liked);

    expect(
      withCampaignReaskCap(botSaid(copy.liked, nudge), campaignQuestion, copy),
    ).toEqual({ outbound: campaignQuestion, stalledOnMessageId: null });
  });

  it("leaves everything that is not a campaign question untouched", () => {
    // Closing copy, the handoff line and the exit line all carry no askedGoal;
    // the assurance-bearing reply carries none either. None of them is a
    // question this path could ask a third time.
    const closing = {
      body: copy.closing,
      dedupeKey: "feedback-closing-conv-1",
    };

    expect(
      withCampaignReaskCap(botSaid(copy.closing, copy.closing), closing, copy),
    ).toEqual({ outbound: closing, stalledOnMessageId: null });
    expect(withCampaignReaskCap(botSaid(copy.liked), undefined, copy)).toEqual({
      outbound: undefined,
      stalledOnMessageId: null,
    });
  });

  it("reproduces the run-13 shape when the cap is not consulted", () => {
    // The falsification. `resolveOutbound` on its own — the code path as it
    // stood — hands back the identical body however many times it has already
    // gone out, and the dedupe key moves with the testimony seq, so nothing
    // downstream would have stopped it either. Remove the cap and this is what
    // the participant receives.
    const uncapped = [9, 11, 13].map((seq) =>
      resolveOutbound(
        conversation,
        validated({
          nextGoal: "meet_again",
          reply: "Τέλεια, το σημείωσα!",
          rejections: [
            {
              scope: "answer",
              reason: "unresolved_subject",
              questionKey: "liked",
            },
          ],
        }),
        false,
        false,
        seq,
        copy,
        "liked",
      )!,
    );

    expect(uncapped.map((outbound) => outbound.body)).toEqual([
      copy.liked,
      copy.liked,
      copy.liked,
    ]);
    expect(new Set(uncapped.map((outbound) => outbound.dedupeKey)).size).toBe(
      3,
    );

    // And the cap is the whole of what stops it: the third of those three, with
    // the first two on the transcript, is withheld.
    expect(
      withCampaignReaskCap(botSaid(copy.liked, copy.liked), uncapped[2], copy)
        .outbound,
    ).toBeUndefined();
  });
});

describe("withSafetyAssurance", () => {
  const reply = { body: "Λυπάμαι πολύ.", dedupeKey: "feedback-reply-conv-1-4" };
  const disclosure = validated({
    nextGoal: "event_score",
    reply: reply.body,
    safetySignals: [
      {
        category: "sexual_misconduct",
        recommendedAction: "human_follow_up",
        sourceMessageIds: ["m1"],
        confidence: 0.9,
      },
    ],
  });

  it("tells the participant their disclosure reached a person, once", () => {
    // Ειρήνη Καταγγελού described being touched under the table. The flag went
    // up, staff were alerted, and she was told none of it — from where she sat
    // she had handed something hard to a questionnaire that moved on. Rule 11ε
    // still forbids the model from promising a human; this sentence belongs to
    // the code that actually raises the alert.
    expect(
      withSafetyAssurance(conversation, disclosure, reply, new Set(["m1"]))
        ?.body,
    ).toContain(POST_EVENT_FEEDBACK_SAFETY_ASSURANCE);

    // Said once. Not because the conversation is flagged — it may have been
    // flagged for something we never promised anything about — but because this
    // sentence is already on her phone.
    expect(
      withSafetyAssurance(
        {
          ...conversation,
          messages: [
            {
              actor: "bot",
              text: `Λυπάμαι πολύ.\n\n${POST_EVENT_FEEDBACK_SAFETY_ASSURANCE}`,
            },
          ],
        } as unknown as FeedbackConversationDocument,
        disclosure,
        reply,
        new Set(["m1"]),
      )?.body,
    ).not.toContain(POST_EVENT_FEEDBACK_SAFETY_ASSURANCE);
  });

  it("waits for the incident instead of promising on the announcement", () => {
    // Νίτσα Κομποσερογιάννη said the end of the evening had left her feeling
    // bad and offered to say what happened. Nothing had been forwarded, because
    // nothing had been said.
    const announcement = validated({
      nextGoal: "event_score",
      reply: "Πες μου αν θέλεις τι έγινε — σε ακούμε.",
      safetySignals: [
        {
          category: "other_safety",
          recommendedAction: "review",
          sourceMessageIds: ["m1"],
          confidence: 0.6,
        },
      ],
    });

    expect(
      withSafetyAssurance(conversation, announcement, reply, new Set())?.body,
    ).not.toContain(POST_EVENT_FEEDBACK_SAFETY_ASSURANCE);

    // And the turn that does carry it earns the line, even though the
    // announcement has already flagged the conversation. This is the half that
    // was silent: she described being pressed for a lift home after saying no
    // twice, and got nothing.
    expect(
      withSafetyAssurance(
        {
          ...conversation,
          needsAttention: true,
        } as FeedbackConversationDocument,
        disclosure,
        reply,
        new Set(["m1"]),
      )?.body,
    ).toContain(POST_EVENT_FEEDBACK_SAFETY_ASSURANCE);
  });

  it("does not promise a personal call to the person who is the incident", () => {
    // Γεωργία Ρατσιστρόνα answered `avoid` by naming an attendee and saying she
    // does not sit at a table with foreigners. The line above is Ειρήνη's — she
    // described being touched, and telling her it reached a person is the least
    // we owe her. Sent here it tells the perpetrator that her racism was
    // forwarded and somebody will speak to her personally: a service performed
    // on her behalf, and a conversation staff never agreed to have.
    const noted = {
      body: "Το σημείωσα.",
      dedupeKey: "feedback-reply-conv-1-6",
    };
    const respondentSource = validated({
      nextGoal: null,
      reply: noted.body,
      safetySignals: [
        {
          category: "abuse_of_a_participant",
          recommendedAction: "human_follow_up",
          sourceMessageIds: ["m2"],
          confidence: 0.88,
        },
      ],
    });

    expect(
      withSafetyAssurance(
        conversation,
        respondentSource,
        noted,
        new Set(["m2"]),
      )?.body,
    ).toBe("Το σημείωσα.");

    // A burst that carries both still earns the line: there is somebody in it
    // to reassure, and the gate is about who the run is answering.
    expect(
      withSafetyAssurance(
        conversation,
        validated({
          nextGoal: null,
          reply: "Λυπάμαι που το ακούω.",
          safetySignals: [
            ...respondentSource.safetySignals,
            {
              category: "sexual_misconduct",
              recommendedAction: "human_follow_up",
              sourceMessageIds: ["m3"],
              confidence: 0.9,
            },
          ],
        }),
        { body: "Λυπάμαι που το ακούω.", dedupeKey: "feedback-reply-conv-1-6" },
        new Set(["m2", "m3"]),
      )?.body,
    ).toContain(POST_EVENT_FEEDBACK_SAFETY_ASSURANCE);
  });
});
