import { z } from "zod";

/**
 * The data-handling questions we recognise, and the sentences we are allowed to
 * answer them with.
 *
 * The design is the one agreed in
 * `docs/backend/modules/post-event-feedback-policy-answers.md`, and the split it
 * encodes is the whole point: **the classifier sees the questions, the
 * application owns the answers.** The attention classifier — which already runs
 * on every participant turn — picks an id from this list or `null`; it is shown
 * what each id *asks* and never what we answer. The extraction model is bound by
 * prompt rule 11στ exactly as before: it must never say anything about data
 * handling of its own. The application then appends the approved sentence the
 * way it appends the safety assurance, same text every time.
 *
 * A misclassification under this split answers a neighbouring question with a
 * sentence that is still true. A generated answer to the same question invents
 * policy. That asymmetry is why no model ever holds one of these sentences in
 * context.
 *
 * The wording was approved by the owner on 2026-08-01, verbatim from the draft.
 * The doc is the source of record and `policy-answers.spec.ts` fails when the
 * two drift apart — edit the doc and this file together or not at all.
 */
export const POST_EVENT_FEEDBACK_POLICY_QUESTIONS = [
  "what_is_it_for",
  "who_sees_it",
  "will_they_find_out",
  "affects_next_tables",
  "show_me_what_others_said",
  "where_did_you_get_my_number",
  "are_you_a_bot",
  "how_long_kept",
  "is_it_anonymous",
  "delete_my_data",
  "other_data_handling",
] as const;

export const postEventFeedbackPolicyQuestionSchema = z.enum(
  POST_EVENT_FEEDBACK_POLICY_QUESTIONS,
);

export type PostEventFeedbackPolicyQuestion = z.infer<
  typeof postEventFeedbackPolicyQuestionSchema
>;

/** One classified data-handling question: who asked it, and which one it is. */
export interface FeedbackPolicyQuestionMatch {
  readonly messageId: string;
  readonly question: PostEventFeedbackPolicyQuestion;
}

interface PolicyQuestionDefinition {
  /**
   * What the participant is asking, phrased for the classifier prompt. This is
   * the only part of an entry a model is ever shown.
   */
  readonly asks: string;
  /**
   * The approved sentence, or `null` for a question we recognise and have
   * decided not to answer yet. `null` earns today's deferral from the model
   * plus an `unanswered_data_question` attention reason, so a person sees that
   * it was asked and the list can grow from evidence.
   */
  readonly answer: string | null;
}

/**
 * `how_long_kept` and `is_it_anonymous` are deliberately unanswered: both need
 * a decision outside engineering, and a wrong answer about retention is worse
 * than a deferral. `delete_my_data` is unanswered for a different reason — it
 * is a request, not a question, the existing handoff path already owns it
 * (prompt rule 10), and it is excluded from the attention raise below so that
 * path is not flagged twice. `other_data_handling` is the catch-all that turns
 * an unmatched question into a note instead of silence.
 *
 * `affects_next_tables`' second sentence is a claim of fact the owner confirmed
 * on 2026-08-01: a person reviews feedback before the next tables are seated.
 * If seating is ever automated, this entry changes the same day.
 */
export const POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS: Record<
  PostEventFeedbackPolicyQuestion,
  PolicyQuestionDefinition
> = {
  what_is_it_for: {
    asks: "γιατί τα ρωτάμε όλα αυτά, τι τα κάνουμε όσα μας λέει",
    answer:
      "Τα χρησιμοποιούμε για να φτιάχνουμε καλύτερες παρέες στα επόμενα τραπέζια — ποιος ταιριάζει με ποιον. Τίποτα άλλο.",
  },
  who_sees_it: {
    asks: "ποιος διαβάζει αυτά που γράφει",
    answer:
      "Τα διαβάζει μόνο η ομάδα του Join The Six. Κανείς από την παρέα σου δεν βλέπει τι έγραψες.",
  },
  will_they_find_out: {
    asks: "αν θα μάθει κάποιος από την παρέα τι είπε — ή ότι το είπε",
    answer:
      "Όχι. Ό,τι μου λες για την παρέα δεν φτάνει ποτέ σε αυτούς — ούτε ότι το είπες.",
  },
  affects_next_tables: {
    asks: "αν αυτά που λέει αλλάζουν με ποιους θα καθίσει την επόμενη φορά",
    answer:
      "Ναι, αυτό ακριβώς είναι — το λαμβάνουμε υπόψη όταν φτιάχνουμε τα επόμενα τραπέζια. Δεν είναι αυτόματο, το βλέπει άνθρωπος.",
  },
  show_me_what_others_said: {
    asks: "να του δείξουμε τι έγραψαν άλλοι γι' αυτόν",
    answer:
      "Δεν μπορώ να σου δείξω τι έγραψε άλλος άνθρωπος — όπως δεν δείχνω σε κανέναν τι έγραψες εσύ.",
  },
  where_did_you_get_my_number: {
    asks: "πώς έχουμε το νούμερό του",
    answer:
      "Από την εγγραφή σου στο Join The Six, για το δείπνο στο οποίο ήσουν.",
  },
  are_you_a_bot: {
    asks: "αν μιλάει με άνθρωπο ή με μηχανή",
    answer:
      "Είμαι αυτοματοποιημένο μήνυμα από την ομάδα του Join The Six — όχι άνθρωπος. Ό,τι μου γράψεις το διαβάζει άνθρωπος.",
  },
  how_long_kept: {
    asks: "πόσο καιρό κρατάμε όσα μας είπε",
    answer: null,
  },
  is_it_anonymous: {
    asks: "αν όσα λέει είναι ανώνυμα",
    answer: null,
  },
  delete_my_data: {
    asks: "να σβήσουμε όσα μας είπε",
    answer: null,
  },
  other_data_handling: {
    asks: "άλλη ερώτηση για το τι κάνουμε με τα δεδομένα ή τις απαντήσεις του που δεν ταιριάζει σε καμία παραπάνω",
    answer: null,
  },
};

/**
 * The questions whose lack of an answer is news an operator should see.
 *
 * Everything with `answer: null` except `delete_my_data`: a deletion request
 * already travels the handoff path with its own flag, and raising a second
 * reason for the same message would be the same news twice.
 */
export function isUnansweredPolicyQuestion(
  question: PostEventFeedbackPolicyQuestion,
): boolean {
  return (
    POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS[question].answer === null &&
    question !== "delete_my_data"
  );
}
