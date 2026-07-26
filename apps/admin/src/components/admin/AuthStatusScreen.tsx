import { Button } from "@heroui/react";

type AuthStatusKind = "checking" | "configuration" | "denied" | "failed";

const COPY: Record<
  AuthStatusKind,
  { readonly eyebrow: string; readonly title: string; readonly detail: string }
> = {
  checking: {
    eyebrow: "Authentication",
    title: "Securing the workspace",
    detail: "Checking your Clerk session and admin access.",
  },
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
      "Your Clerk session is valid, but the backend has not authorized this profile for Join The Six.",
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

/** Full-page auth loading/configuration/failure state with one clear recovery. */
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
      <section
        aria-live={kind === "checking" ? "polite" : undefined}
        aria-busy={kind === "checking" ? "true" : undefined}
        className="w-full max-w-lg border-l-[3px] border-primary bg-surface p-8 shadow-sm"
      >
        <div className="mb-6 flex items-center gap-3">
          <span className="brand-mark" aria-hidden="true" />
          <span className="text-xs font-extrabold uppercase tracking-caps text-ink-muted">
            Join The Six
          </span>
        </div>
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
