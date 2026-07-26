import {
  foldPostEventFeedbackText,
  foldedTextContainsAtWordStart,
} from "./matching/fold-text.js";

/**
 * Opt-out commands, compared against the whole folded message.
 *
 * `σταματηστε` is here and bare `σταματα` deliberately is not: the formal plural
 * is addressed to us, while the singular is as likely to be half a sentence
 * about the evening as a request to be left alone.
 */
const POST_EVENT_FEEDBACK_STOP_COMMANDS = [
  "stop",
  "stop all",
  "unsubscribe",
  "διακοπη",
  "στοπ",
  "σταματηστε",
] as const;

/**
 * Politeness that may follow a command without changing what it means. Somebody
 * annoyed enough to type STOP often softens it, and «Στοπ ευχαριστώ» is an
 * opt-out by any reading.
 */
const POST_EVENT_FEEDBACK_STOP_COURTESY = [
  "ευχαριστω",
  "ευχαριστω πολυ",
  "παρακαλω",
  "please",
  "thanks",
  "thank you",
  "ok",
  "οκ",
] as const;

/**
 * Plain-language opt-outs, matched wherever they begin a word.
 *
 * Every entry is several words long, is addressed to us, and says something
 * nobody says about a dinner — which is what makes matching them anywhere safe.
 * «σταμάτα να ρωτάς για τον Νίκο» is an objection to a question rather than to
 * being messaged and matches nothing here; so does «σταματήστε να ρωτάτε για
 * τον Κώστα», because the entry that begins the same way requires «μου
 * στέλνετε» to follow.
 *
 * These were anchored to the start of the message until «5 πάντως. μη μου
 * ξαναστείλετε μηνύματα παρακαλώ» showed the cost: people put the answer first
 * and the opt-out after it, and anchoring read the consent half as testimony
 * about the evening. Withdrawal of consent is not a thing to notice only when
 * it is the first thing typed.
 *
 * Commands are unaffected and still require the whole message, so the intro's
 * own «γράψε ΣΤΟΠ.» quoted back still closes nothing.
 */
const POST_EVENT_FEEDBACK_STOP_PHRASES = [
  "μη μου ξαναστειλετε",
  "μην μου ξαναστειλετε",
  "μη μου ξαναγραψετε",
  "μην μου ξαναγραψετε",
  "μη μου στελνετε",
  "μην μου στελνετε",
  "μη μου ξαναστειλεις",
  "μην μου ξαναστειλεις",
  "δεν θελω αλλα μηνυματα",
  "δε θελω αλλα μηνυματα",
  "δεν θελω να λαμβανω",
  "σταματηστε να μου στελνετε",
  // The singular is safe *here* only because the rest of the phrase is: bare
  // «σταμάτα» is half a sentence about the evening, while «σταμάτα να μου
  // στέλνεις» can only be addressed to us. «σταμάτα να ρωτάς για τον Νίκο» is
  // the objection this must keep missing, and it does — different verb.
  "σταματα να μου στελνεις",
  "σταματα να μου γραφεις",
  "mi mou ksanasteilete",
  "min mou ksanasteilete",
  "stop na mou stelnete",
  "den thelo alla minimata",
  "no more messages",
  "unsubscribe me",
] as const;

/**
 * D14: STOP is deterministic and is decided before any model call, because an
 * opt-out that depends on a model is not an opt-out.
 *
 * Three ways to say it, in widening order of tolerance and narrowing order of
 * confidence: the whole message is a command; the whole message is a command
 * plus politeness; the message opens with an unambiguous plain-language
 * opt-out. Nothing matches a command found *inside* a sentence — the intro copy
 * itself ends «γράψε ΣΤΟΠ.», and quoting it back must not close the
 * conversation.
 */
export function matchesPostEventFeedbackStopCommand(text: string): boolean {
  const folded = foldPostEventFeedbackText(text);
  if (folded.length === 0) {
    return false;
  }

  for (const command of POST_EVENT_FEEDBACK_STOP_COMMANDS) {
    if (folded === command) {
      return true;
    }
    if (
      folded.startsWith(`${command} `) &&
      (POST_EVENT_FEEDBACK_STOP_COURTESY as readonly string[]).includes(
        folded.slice(command.length + 1),
      )
    ) {
      return true;
    }
  }

  return POST_EVENT_FEEDBACK_STOP_PHRASES.some((phrase) =>
    foldedTextContainsAtWordStart(folded, phrase),
  );
}
