import { z } from "zod";

/**
 * Recognised data-handling questions and the sentences we may answer them with.
 *
 * The classifier sees `asks` only and never the answer text; the application
 * appends the approved sentence (same shape as the safety assurance). Prompt
 * rule 11στ still forbids the extraction model from inventing policy. A
 * neighbouring misclassification stays a true sentence; a generated answer
 * invents policy. Keep this file aligned with
 * `docs/backend/modules/post-event-feedback-policy-answers.md`.
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
   * Approved sentence, or `null` to defer plus raise `unanswered_data_question`.
   */
  readonly answer: string | null;
}

/**
 * `how_long_kept` and `is_it_anonymous` stay unanswered (wrong retention copy
 * is worse than deferral). `delete_my_data` is a request owned by the handoff
 * path and is excluded from the raise below so it is not flagged twice.
 * `other_data_handling` is the unmatched catch-all. `affects_next_tables`
 * claims a human reviews seating — change it if that becomes automatic.
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
 * Unanswered policy questions that should surface for an operator. Everything
 * with `answer: null` except `delete_my_data` (already on the handoff path).
 */
export function isUnansweredPolicyQuestion(
  question: PostEventFeedbackPolicyQuestion,
): boolean {
  return (
    POST_EVENT_FEEDBACK_POLICY_QUESTION_DEFINITIONS[question].answer === null &&
    question !== "delete_my_data"
  );
}
