import { SignIn, useAuth } from "@clerk/react";
import { Navigate } from "react-router";

import { AuthStatusScreen } from "../components/admin/AuthStatusScreen";
import { BrandLockup } from "../components/admin/BrandLockup";
import { usePageMeta } from "../lib/usePageMeta";

export function SignInPage() {
  const { isLoaded, isSignedIn } = useAuth();

  usePageMeta(
    "Admin sign in",
    "Secure sign in for the Join The Six administration panel.",
  );

  if (!isLoaded) {
    return <AuthStatusScreen kind="checking" />;
  }

  if (isSignedIn) {
    return <Navigate to="/admin" replace />;
  }

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="grid min-h-screen bg-canvas lg:grid-cols-[minmax(0,0.9fr)_minmax(28rem,1.1fr)]"
    >
      <section className="hidden border-r border-sidebar-border bg-sidebar p-12 text-sidebar-fg lg:flex lg:flex-col lg:justify-between">
        <BrandLockup surface="strong" wordmarkClassName="text-xl" />
        <div className="max-w-lg">
          <p className="text-xs font-extrabold uppercase tracking-caps text-sidebar-fg-muted">
            Private operations
          </p>
          <p className="mt-4 font-display text-4xl font-extrabold leading-tight tracking-tight">
            One secure entrance to the admin workspace.
          </p>
          <p className="mt-5 max-w-prose text-sm leading-6 text-sidebar-fg-muted">
            Sign-in proves identity. The backend separately checks that your
            Clerk profile is approved for this admin.
          </p>
        </div>
        <p className="text-xs font-semibold text-sidebar-fg-muted">
          Authorized staff only
        </p>
      </section>

      <section
        aria-label="Admin authentication"
        className="grid place-items-center p-6 sm:p-10"
      >
        <div className="grid w-full max-w-md justify-items-center gap-6">
          <BrandLockup
            surface="default"
            className="lg:hidden"
            wordmarkClassName="text-xl text-ink"
          />
          <SignIn
            path="/sign-in"
            routing="path"
            fallbackRedirectUrl="/admin"
            fallback={<p role="status">Loading secure sign-in…</p>}
            appearance={{
              variables: {
                colorBackground: "var(--jts-color-surface)",
                colorDanger: "var(--jts-color-danger)",
                colorForeground: "var(--jts-color-text)",
                colorPrimary: "var(--jts-color-primary)",
                fontFamily: "var(--jts-font-sans)",
                borderRadius: "var(--jts-radius-md)",
              },
            }}
          />
        </div>
      </section>
    </main>
  );
}
