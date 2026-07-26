import {
  isUnresolvedParticipant,
  participantLabel,
} from "../../../features/feedback/labels";

/** Renders a participant name, marking the D18 fallback so it reads as absence. */
export function ParticipantName({
  displayName,
}: {
  displayName: string | null;
}) {
  return (
    <span
      className={
        isUnresolvedParticipant(displayName)
          ? "italic text-ink-muted"
          : undefined
      }
    >
      {participantLabel(displayName)}
    </span>
  );
}
