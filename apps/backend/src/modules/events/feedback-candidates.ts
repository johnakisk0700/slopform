/**
 * Shared D16 eligibility rule: feedback candidates are present attendees of an
 * event, excluding the respondent. Extraction and validation must both call
 * {@link listFeedbackCandidatesForRespondent} (or this predicate through it)
 * rather than re-implementing the filter.
 */
export function isFeedbackCandidateAttendee(
  attendee: { readonly participantId: string; readonly present: boolean },
  respondentParticipantId: string,
): boolean {
  return attendee.present && attendee.participantId !== respondentParticipantId;
}

export function selectFeedbackCandidates<
  T extends {
    readonly participantId: string;
    readonly present: boolean;
    readonly displayName: string;
  },
>(attendees: readonly T[], respondentParticipantId: string): readonly T[] {
  return attendees.filter((attendee) =>
    isFeedbackCandidateAttendee(attendee, respondentParticipantId),
  );
}
