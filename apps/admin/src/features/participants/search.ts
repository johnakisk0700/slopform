/**
 * The three fields a staff member types when looking for someone. Declared as
 * the narrowest input this rule needs rather than any generated DTO, so both
 * the participants list and the event attendee picker can pass their own row
 * type without either of them being copied here.
 */
export interface ParticipantSearchFields {
  preferredName: string | null;
  emailNormalized: string;
  phoneE164: string | null;
}

/**
 * Folds case and strips accents. «Άκης», «ακης» and «Ακης» are the same person
 * being looked for, and an operator typing a name into a search box should not
 * have to reproduce its tonos to find them.
 */
export function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase("el")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/**
 * True when every whitespace-separated term appears somewhere in the person's
 * name, email or phone. All terms must match, so typing more narrows rather
 * than widens — «maria pap» finds one Maria out of four.
 */
export function matchesParticipantQuery(
  participant: ParticipantSearchFields,
  query: string,
): boolean {
  const terms = normalizeSearchText(query)
    .split(/\s+/)
    .filter((term) => term !== "");
  if (terms.length === 0) {
    return true;
  }
  const haystack = normalizeSearchText(
    [
      participant.preferredName ?? "",
      participant.emailNormalized,
      participant.phoneE164 ?? "",
    ].join(" "),
  );
  return terms.every((term) => haystack.includes(term));
}

/** Alphabetical by the name we would actually show, Greek collation. */
export function compareParticipantsByName(
  left: ParticipantSearchFields,
  right: ParticipantSearchFields,
): number {
  return (left.preferredName ?? left.emailNormalized).localeCompare(
    right.preferredName ?? right.emailNormalized,
    "el",
  );
}
