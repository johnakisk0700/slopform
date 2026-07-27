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
  const candidates = linesAfterHeader(
    userPrompt,
    "ΥΠΟΨΗΦΙΟΙ (μόνο αυτοί επιτρέπονται ως υποκείμενα)",
  )
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

  const newMessageIds = linesAfterHeader(
    userPrompt,
    "ΝΕΑ ΜΗΝΥΜΑΤΑ ΠΡΟΣ ΕΞΑΓΩΓΗ",
  )
    .map((line) => {
      const match = NEW_MESSAGE_LINE.exec(line);
      return match?.groups?.["messageId"] ?? null;
    })
    .filter((id): id is string => id !== null);

  const transcript = linesAfterHeader(userPrompt, "ΣΥΝΟΜΙΛΙΑ")
    .map((line) => {
      const match = TRANSCRIPT_LINE.exec(line);
      if (!match?.groups) {
        return null;
      }
      return {
        seq: Number(match.groups["seq"]),
        occurredAt: match.groups["occurredAt"]!,
        id: match.groups["id"]!,
        actor: match.groups["actor"]!,
        text: match.groups["text"]!,
      };
    })
    .filter((entry): entry is ParsedBurstTranscriptMessage => entry !== null);

  return { candidates, newMessageIds, transcript };
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
