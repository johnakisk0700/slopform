/**
 * Recovers the structured inputs the scripted burst model needs from the
 * rendered Greek extraction prompt. The seam only passes prose, so this is the
 * only way to map a persona's `about: "<display name>"` and `cite` tokens onto
 * real participant and message ids.
 */

export interface ParsedBurstCandidate {
  readonly participantId: string;
  readonly displayName: string;
}

export interface ParsedBurstTranscriptMessage {
  readonly seq: number;
  readonly occurredAt: string;
  readonly id: string;
  readonly actor: string;
  readonly text: string;
}

export interface ParsedBurstExtractionPrompt {
  /**
   * The person writing. A stub may deliberately name them — that is the whole
   * point of the persona who answers «εμένα μου άρεσα» — and validation must be
   * the thing that refuses it, not the stub's inability to express it.
   */
  readonly respondent: ParsedBurstCandidate | undefined;
  readonly candidates: readonly ParsedBurstCandidate[];
  readonly newMessageIds: readonly string[];
  readonly transcript: readonly ParsedBurstTranscriptMessage[];
}

const CANDIDATE_LINE = /^- (?<participantId>\S+) = (?<displayName>.+)$/u;
const NEW_MESSAGE_LINE = /^- (?<messageId>\S+)$/u;
const TRANSCRIPT_LINE =
  /^\[(?<seq>\d+)\] at=(?<occurredAt>\S+) id=(?<id>\S+) actor=(?<actor>\S+): (?<text>.*)$/u;

export function parseBurstExtractionPrompt(
  userPrompt: string,
): ParsedBurstExtractionPrompt {
  const respondent = parseCandidateLines(
    linesAfterHeader(
      userPrompt,
      "ΣΥΝΟΜΙΛΗΤΗΣ (αυτός γράφει· ποτέ δεν είναι υποκείμενο)",
    ),
  )[0];

  const candidates = parseCandidateLines(
    linesAfterHeader(
      userPrompt,
      "ΥΠΟΨΗΦΙΟΙ (μόνο αυτοί επιτρέπονται ως υποκείμενα)",
    ),
  );

  const newMessageIds = linesAfterHeader(
    userPrompt,
    "ΝΕΑ ΜΗΝΥΜΑΤΑ ΠΡΟΣ ΕΞΑΓΩΓΗ",
  )
    .map((line) => {
      const match = NEW_MESSAGE_LINE.exec(line);
      return match?.groups?.["messageId"] ?? null;
    })
    .filter((id): id is string => id !== null);

  const transcript = scanTranscript(userPrompt);

  return { respondent, candidates, newMessageIds, transcript };
}

/**
 * Parse the final transcript section without treating message line breaks as
 * section delimiters.
 *
 * `formatTranscript` renders stored text verbatim. Application-owned replies
 * can therefore contain a blank line before a safety assurance, and participant
 * messages may be multiline too. The generic section reader must stop at blank
 * lines for every earlier prompt block; using it here used to truncate the
 * transcript at that assurance and hide every later participant turn from the
 * deterministic rehearsal stub.
 */
function scanTranscript(prompt: string): ParsedBurstTranscriptMessage[] {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => line.trim() === "ΣΥΝΟΜΙΛΙΑ");
  if (start < 0) {
    return [];
  }

  const messages: ParsedBurstTranscriptMessage[] = [];
  let current:
    | (Omit<ParsedBurstTranscriptMessage, "text"> & {
        readonly textLines: string[];
      })
    | undefined;

  const flush = (): void => {
    if (!current) {
      return;
    }
    messages.push({
      seq: current.seq,
      occurredAt: current.occurredAt,
      id: current.id,
      actor: current.actor,
      text: current.textLines.join("\n"),
    });
  };

  for (const line of lines.slice(start + 1)) {
    const match = TRANSCRIPT_LINE.exec(line);
    if (match?.groups) {
      flush();
      current = {
        seq: Number(match.groups["seq"]),
        occurredAt: match.groups["occurredAt"]!,
        id: match.groups["id"]!,
        actor: match.groups["actor"]!,
        textLines: [match.groups["text"]!],
      };
      continue;
    }
    current?.textLines.push(line);
  }
  flush();
  return messages;
}

function parseCandidateLines(lines: readonly string[]): ParsedBurstCandidate[] {
  return lines
    .map((line) => {
      const match = CANDIDATE_LINE.exec(line);
      if (!match?.groups) {
        return null;
      }
      return {
        participantId: match.groups["participantId"]!,
        displayName: match.groups["displayName"]!.trim(),
      };
    })
    .filter((entry): entry is ParsedBurstCandidate => entry !== null);
}

/**
 * Collects non-empty lines after `header` until the next blank-separated
 * section header (a non-indented line with no leading `-` or `[`).
 */
function linesAfterHeader(prompt: string, header: string): string[] {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) {
    return [];
  }

  const collected: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") {
      if (collected.length > 0) {
        break;
      }
      continue;
    }
    // The next section title is a bare Greek heading, never a list or transcript
    // line. Stop before it so we do not swallow later blocks.
    if (
      !line.startsWith("- ") &&
      !line.startsWith("[") &&
      collected.length > 0
    ) {
      break;
    }
    if (line.startsWith("- ") || line.startsWith("[")) {
      collected.push(line);
    }
  }
  return collected;
}
