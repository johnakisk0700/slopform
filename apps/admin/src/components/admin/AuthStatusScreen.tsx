import { Button } from "@heroui/react";

import { BrandLockup } from "./BrandLockup";

type AuthStatusKind = "configuration" | "denied" | "failed";

const COPY: Record<
  AuthStatusKind,
  { readonly eyebrow: string; readonly title: string; readonly detail: string }
> = {
  configuration: {
    eyebrow: "Configuration required",
    title: "Admin sign-in is not configured",
    detail:
      "Set VITE_CLERK_PUBLISHABLE_KEY for this build, then rebuild the admin client.",
  },
  denied: {
    eyebrow: "Access denied",
    title: "This profile is not an admin",
    detail:
      "Your Clerk session is valid, but the backend has not authorized this profile for Slopform.",
  },
  failed: {
    eyebrow: "Authentication unavailable",
    title: "We could not verify admin access",
    detail:
      "The authentication service did not respond correctly. Retry before continuing.",
  },
};

interface AuthStatusScreenProps {
  kind: AuthStatusKind;
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * Full-page auth configuration/denial/failure state with one clear recovery.
 * A wait is not one of these: it has nothing to say and no action, so it gets
 * `AuthPendingScreen` instead.
 */
export function AuthStatusScreen({
  kind,
  actionLabel,
  onAction,
}: AuthStatusScreenProps) {
  const copy = COPY[kind];

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="grid min-h-screen place-items-center bg-canvas p-6"
    >
      <section className="w-full max-w-lg border-l-[3px] border-primary bg-surface p-8 shadow-sm">
        <BrandLockup
          surface="default"
          className="mb-6"
          wordmark={
            <span className="text-xs font-extrabold uppercase tracking-caps text-ink-muted">
              Slopform
            </span>
          }
        />
        <p className="text-xs font-extrabold uppercase tracking-caps text-primary">
          {copy.eyebrow}
        </p>
        <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-ink">
          {copy.title}
        </h1>
        <p className="mt-4 max-w-prose text-sm leading-6 text-ink-muted">
          {copy.detail}
        </p>
        {actionLabel && onAction ? (
          <Button className="mt-6" variant="primary" onPress={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </section>
    </main>
  );
}
