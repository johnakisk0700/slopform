import { Avatar } from "@heroui/react";
import { Link } from "react-router";

import { participantMonogram } from "../../../features/participants/profileFields";

interface ParticipantIdentityProps {
  /** The profile's preferred name; falls back to the email when absent. */
  preferredName: string | null;
  emailNormalized: string;
  /** Renders the name as a link to this route. Plain text when omitted. */
  to?: string;
  /** Hides the second line where the surrounding surface already shows it. */
  showEmail?: boolean;
}

/**
 * One person, said the same way everywhere: the monogram square, the name they
 * go by, and the email underneath as the thing that actually distinguishes two
 * people called Maria.
 *
 * The rounded square is deliberate — the circle motif stays reserved for the
 * brand mark, as on the participant profile this borrows its shape from.
 */
export function ParticipantIdentity({
  preferredName,
  emailNormalized,
  to,
  showEmail = true,
}: ParticipantIdentityProps) {
  const name = preferredName?.trim() || emailNormalized;
  const monogram = participantMonogram(preferredName, emailNormalized);
  // With no name to show, the email is already the heading — repeating it
  // underneath would be the same string twice.
  const secondary = showEmail && name !== emailNormalized;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar
        color="default"
        variant="soft"
        aria-hidden="true"
        className="size-8 shrink-0 rounded-md border border-border"
      >
        <Avatar.Fallback className="bg-surface-raised text-xs font-extrabold text-ink">
          {monogram}
        </Avatar.Fallback>
      </Avatar>
      <div className="min-w-0">
        {to ? (
          <Link
            to={to}
            className="block truncate font-bold text-primary underline-offset-2 hover:underline"
          >
            {name}
          </Link>
        ) : (
          <span className="block truncate font-semibold text-ink">{name}</span>
        )}
        {secondary ? (
          <span className="block truncate text-xs text-ink-muted">
            {emailNormalized}
          </span>
        ) : null}
      </div>
    </div>
  );
}
