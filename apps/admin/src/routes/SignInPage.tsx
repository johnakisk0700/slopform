import { SignIn, useAuth } from "@clerk/react";
import { Navigate } from "react-router";

import {
  SignInFormPlaceholder,
  SignInLayout,
} from "../components/admin/SignInLayout";
import { usePageMeta } from "../lib/usePageMeta";

/**
 * Clerk's widget wearing this admin's chrome. Everything around the form —
 * heading, panel, card — belongs to `SignInLayout`, so the appearance below
 * only has to stop Clerk from drawing a second card inside ours and point its
 * own vocabulary at the tokens.
 */
const SIGN_IN_APPEARANCE = {
  layout: {
    // Our lockup is already on the page, twice over on small screens.
    logoPlacement: "none",
  },
  variables: {
    colorBackground: "var(--jts-color-surface)",
    colorBorder: "var(--jts-color-border-strong)",
    colorDanger: "var(--jts-color-danger)",
    colorForeground: "var(--jts-color-text)",
    colorInput: "var(--jts-color-surface-raised)",
    colorInputForeground: "var(--jts-color-text)",
    colorMuted: "var(--jts-color-surface-sunken)",
    colorMutedForeground: "var(--jts-color-text-muted)",
    colorPrimary: "var(--jts-color-primary)",
    colorPrimaryForeground: "var(--jts-color-primary-contrast)",
    colorRing: "var(--jts-color-focus)",
    colorSuccess: "var(--jts-color-success)",
    colorWarning: "var(--jts-color-warning)",
    fontFamily: "var(--jts-font-sans)",
    borderRadius: "var(--jts-radius-md)",
  },
  // Style objects, not Tailwind classes: Clerk injects its own stylesheet
  // unlayered, and unlayered rules beat every utility Tailwind emits from a
  // cascade layer. The card the page already draws is the only card: Clerk's
  // frame flattens into it, and its «Secured by Clerk» footer becomes that
  // card's bottom band instead of a strip floating under the button.
  elements: {
    rootBox: { width: "100%" },
    cardBox: {
      width: "100%",
      border: "none",
      borderRadius: 0,
      background: "transparent",
      boxShadow: "none",
    },
    card: {
      width: "100%",
      margin: 0,
      border: "none",
      borderRadius: 0,
      background: "transparent",
      boxShadow: "none",
      padding: "var(--jts-space-8)",
    },
    // The page owns the `h1`; Clerk's own title would be the second one.
    header: { display: "none" },
    // Google is the intended way in, so it is the biggest thing in the card
    // rather than a quiet strip above the divider. Clerk's controls default to
    // 32px, which reads as a widget dropped into the page; 40px is the height
    // the rest of the admin's controls use.
    socialButtonsBlockButton: {
      minHeight: "2.75rem",
      fontSize: "var(--jts-text-sm)",
      fontWeight: "var(--jts-weight-bold)",
      background: "var(--jts-color-surface-raised)",
      borderColor: "var(--jts-color-border-strong)",
    },
    socialButtonsProviderIcon: { width: "1.15rem", height: "1.15rem" },
    formFieldInput: { minHeight: "2.5rem", fontSize: "var(--jts-text-sm)" },
    formButtonPrimary: {
      minHeight: "2.5rem",
      fontSize: "var(--jts-text-sm)",
      fontWeight: "var(--jts-weight-bold)",
    },
    footer: {
      margin: 0,
      padding: "var(--jts-space-4)",
      background: "var(--jts-color-surface-sunken)",
      borderTop: "1px solid var(--jts-color-border)",
    },
  },
} as const;

export function SignInPage() {
  const { isSignedIn } = useAuth();

  usePageMeta(
    "Admin sign in",
    "Secure sign in for the Slopform administration panel.",
  );

  if (isSignedIn) {
    return <Navigate to="/admin" replace />;
  }

  return (
    <SignInLayout>
      <SignIn
        path="/sign-in"
        routing="path"
        fallbackRedirectUrl="/admin"
        fallback={<SignInFormPlaceholder />}
        appearance={SIGN_IN_APPEARANCE}
      />
    </SignInLayout>
  );
}
