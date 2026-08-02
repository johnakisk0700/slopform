/**
 * How a participant's stored profile codes read on screen.
 *
 * The values are storage codes (`45_54`, `nea_smyrni`) that no operator should
 * ever see raw. Both the profile route and the feedback inbox's respondent card
 * read the same participant record, so they share one rendering of it — a
 * second copy is how `55_plus` ends up displayed two different ways.
 *
 * `null` means "nothing stored" and stays `null`: how a missing field looks is
 * the screen's decision, not this module's.
 */

/** Display-only: `45_54` → `45–54`, `55_plus` → `55+`. */
export function formatAgeBand(value: string | null): string | null {
  if (value === null || value === "") {
    return null;
  }
  if (value === "55_plus") {
    return "55+";
  }
  const match = /^(\d+)_(\d+)$/.exec(value);
  return match ? `${match[1]}–${match[2]}` : value;
}

/**
 * First letter of the best name we hold, upper-cased; «?» when we hold none.
 * The profile header and every list row that shows a monogram square derive it
 * the same way, so the same person is never two different letters.
 */
export function participantMonogram(
  preferredName: string | null,
  emailNormalized: string,
): string {
  const source = preferredName?.trim() || emailNormalized.trim();
  return source.charAt(0).toLocaleUpperCase() || "?";
}

/** Display-only: `nea_smyrni` → `Nea Smyrni`. */
export function formatNeighborhood(value: string | null): string | null {
  if (value === null || value === "") {
    return null;
  }
  return value
    .split("_")
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ");
}
